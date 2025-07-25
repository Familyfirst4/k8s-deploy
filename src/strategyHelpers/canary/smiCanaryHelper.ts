import {Kubectl} from '../../types/kubectl'
import * as core from '@actions/core'
import * as fs from 'fs'
import * as yaml from 'js-yaml'

import * as fileHelper from '../../utilities/fileUtils'
import * as kubectlUtils from '../../utilities/trafficSplitUtils'
import * as canaryDeploymentHelper from './canaryHelper'
import * as podCanaryHelper from './podCanaryHelper'
import {isDeploymentEntity, isServiceEntity} from '../../types/kubernetesTypes'
import {checkForErrors} from '../../utilities/kubectlUtils'
import {inputAnnotations} from '../../inputUtils'
import {DeployResult} from '../../types/deployResult'
import {K8sObject} from '../../types/k8sObject'

const TRAFFIC_SPLIT_OBJECT_NAME_SUFFIX = '-workflow-rollout'
const TRAFFIC_SPLIT_OBJECT = 'TrafficSplit'

export async function deploySMICanary(
   filePaths: string[],
   kubectl: Kubectl,
   onlyDeployStable: boolean = false,
   timeout?: string
): Promise<DeployResult> {
   const canaryReplicasInput = core.getInput('baseline-and-canary-replicas')
   let canaryReplicaCount
   let calculateReplicas = true
   if (canaryReplicasInput !== '') {
      canaryReplicaCount = parseInt(canaryReplicasInput)
      calculateReplicas = false
      core.debug(
         `read replica count ${canaryReplicaCount} from input: ${canaryReplicasInput}`
      )
   }

   if (canaryReplicaCount < 0 && canaryReplicaCount > 100)
      throw Error('Baseline-and-canary-replicas must be between 0 and 100')

   const newObjectsList = []
   for await (const filePath of filePaths) {
      try {
         const fileContents = fs.readFileSync(filePath).toString()
         const inputObjects: K8sObject[] = yaml.loadAll(
            fileContents
         ) as K8sObject[]
         for (const inputObject of inputObjects) {
            const name = inputObject.metadata.name
            const kind = inputObject.kind

            if (!onlyDeployStable && isDeploymentEntity(kind)) {
               if (calculateReplicas) {
                  // calculate for each object
                  const percentage = parseInt(
                     core.getInput('percentage', {required: true})
                  )
                  canaryReplicaCount =
                     podCanaryHelper.calculateReplicaCountForCanary(
                        inputObject,
                        percentage
                     )
                  core.debug(`calculated replica count ${canaryReplicaCount}`)
               }

               core.debug('Creating canary object')
               const newCanaryObject =
                  canaryDeploymentHelper.getNewCanaryResource(
                     inputObject,
                     canaryReplicaCount
                  )
               newObjectsList.push(newCanaryObject)

               const stableObject = await canaryDeploymentHelper.fetchResource(
                  kubectl,
                  kind,
                  canaryDeploymentHelper.getStableResourceName(name)
               )
               if (stableObject) {
                  core.debug(
                     `Stable object found for ${kind} ${name}. Creating baseline objects`
                  )
                  const newBaselineObject =
                     canaryDeploymentHelper.getBaselineDeploymentFromStableDeployment(
                        stableObject,
                        canaryReplicaCount
                     )
                  newObjectsList.push(newBaselineObject)
               }
            } else if (isDeploymentEntity(kind)) {
               core.debug(
                  `creating stable deployment with ${inputObject.spec.replicas} replicas`
               )
               const stableDeployment =
                  canaryDeploymentHelper.getStableResource(inputObject)
               newObjectsList.push(stableDeployment)
            } else {
               // Update non deployment entity or stable deployment as it is
               newObjectsList.push(inputObject)
            }
         }
      } catch (error) {
         core.error(`Failed to process file at ${filePath}: ${error.message}`)
         throw error
      }
   }
   core.debug(
      `deploying canary objects with SMI: \n ${JSON.stringify(newObjectsList)}`
   )
   const newFilePaths = fileHelper.writeObjectsToFile(newObjectsList)
   const forceDeployment = core.getInput('force').toLowerCase() === 'true'
   const serverSideApply = core.getInput('server-side').toLowerCase() === 'true'

   const result = await kubectl.apply(
      newFilePaths,
      forceDeployment,
      serverSideApply,
      timeout
   )
   const svcDeploymentFiles = await createCanaryService(
      kubectl,
      filePaths,
      timeout
   )
   checkForErrors([result])
   newFilePaths.push(...svcDeploymentFiles)
   return {execResult: result, manifestFiles: newFilePaths}
}

async function createCanaryService(
   kubectl: Kubectl,
   filePaths: string[],
   timeout?: string
): Promise<string[]> {
   const newObjectsList = []
   const trafficObjectsList: string[] = []

   for (const filePath of filePaths) {
      try {
         const fileContents = fs.readFileSync(filePath).toString()
         const parsedYaml: K8sObject[] = yaml.loadAll(
            fileContents
         ) as K8sObject[]

         for (const inputObject of parsedYaml) {
            const name = inputObject.metadata.name
            const kind = inputObject.kind

            if (isServiceEntity(kind)) {
               core.debug(`Creating services for ${kind} ${name}`)
               const newCanaryServiceObject =
                  canaryDeploymentHelper.getNewCanaryResource(inputObject)
               newObjectsList.push(newCanaryServiceObject)

               const newBaselineServiceObject =
                  canaryDeploymentHelper.getNewBaselineResource(inputObject)
               newObjectsList.push(newBaselineServiceObject)

               const stableObject = await canaryDeploymentHelper.fetchResource(
                  kubectl,
                  kind,
                  canaryDeploymentHelper.getStableResourceName(name)
               )
               if (!stableObject) {
                  const newStableServiceObject =
                     canaryDeploymentHelper.getStableResource(inputObject)
                  newObjectsList.push(newStableServiceObject)

                  core.debug('Creating the traffic object for service: ' + name)
                  const trafficObject = await createTrafficSplitManifestFile(
                     kubectl,
                     name,
                     0,
                     0,
                     1000,
                     timeout
                  )

                  trafficObjectsList.push(trafficObject)
               } else {
                  let updateTrafficObject = true
                  const trafficObject =
                     await canaryDeploymentHelper.fetchResource(
                        kubectl,
                        TRAFFIC_SPLIT_OBJECT,
                        getTrafficSplitResourceName(name)
                     )

                  if (trafficObject) {
                     const trafficJObject = JSON.parse(
                        JSON.stringify(trafficObject)
                     )
                     if (trafficJObject?.spec?.backends) {
                        trafficJObject.spec.backends.forEach((s) => {
                           if (
                              s.service ===
                                 canaryDeploymentHelper.getCanaryResourceName(
                                    name
                                 ) &&
                              s.weight === '1000m'
                           ) {
                              core.debug('Update traffic objcet not required')
                              updateTrafficObject = false
                           }
                        })
                     }
                  }

                  if (updateTrafficObject) {
                     core.debug(
                        'Stable service object present so updating the traffic object for service: ' +
                           name
                     )
                     trafficObjectsList.push(
                        await updateTrafficSplitObject(kubectl, name)
                     )
                  }
               }
            }
         }
      } catch (error) {
         core.error(`Failed to process file at ${filePath}: ${error.message}`)
         throw error
      }
   }

   const manifestFiles = fileHelper.writeObjectsToFile(newObjectsList)
   manifestFiles.push(...trafficObjectsList)
   const forceDeployment = core.getInput('force').toLowerCase() === 'true'
   const serverSideApply = core.getInput('server-side').toLowerCase() === 'true'

   const result = await kubectl.apply(
      manifestFiles,
      forceDeployment,
      serverSideApply,
      timeout
   )
   checkForErrors([result])
   return manifestFiles
}

export async function redirectTrafficToCanaryDeployment(
   kubectl: Kubectl,
   manifestFilePaths: string[],
   timeout?: string
) {
   await adjustTraffic(kubectl, manifestFilePaths, 0, 1000, timeout)
}

export async function redirectTrafficToStableDeployment(
   kubectl: Kubectl,
   manifestFilePaths: string[],
   timeout?: string
): Promise<string[]> {
   return await adjustTraffic(kubectl, manifestFilePaths, 1000, 0, timeout)
}

async function adjustTraffic(
   kubectl: Kubectl,
   manifestFilePaths: string[],
   stableWeight: number,
   canaryWeight: number,
   timeout?: string
) {
   if (!manifestFilePaths || manifestFilePaths?.length == 0) {
      return
   }

   const trafficSplitManifests = []
   for (const filePath of manifestFilePaths) {
      try {
         const fileContents = fs.readFileSync(filePath).toString()
         const parsedYaml: K8sObject[] = yaml.loadAll(
            fileContents
         ) as K8sObject[]

         for (const inputObject of parsedYaml) {
            const name = inputObject.metadata.name
            const kind = inputObject.kind

            if (isServiceEntity(kind)) {
               trafficSplitManifests.push(
                  await createTrafficSplitManifestFile(
                     kubectl,
                     name,
                     stableWeight,
                     0,
                     canaryWeight,
                     timeout
                  )
               )
            }
         }
      } catch (error) {
         core.error(`Failed to process file at ${filePath}: ${error.message}`)
         throw error
      }
   }

   if (trafficSplitManifests.length <= 0) {
      return
   }

   const forceDeployment = core.getInput('force').toLowerCase() === 'true'
   const serverSideApply = core.getInput('server-side').toLowerCase() === 'true'
   const result = await kubectl.apply(
      trafficSplitManifests,
      forceDeployment,
      serverSideApply,
      timeout
   )
   checkForErrors([result])
   return trafficSplitManifests
}

async function updateTrafficSplitObject(
   kubectl: Kubectl,
   serviceName: string
): Promise<string> {
   const percentage = parseInt(core.getInput('percentage', {required: true}))
   if (percentage < 0 || percentage > 100)
      throw Error('Percentage must be between 0 and 100')

   const percentageWithMuliplier = percentage * 10
   const baselineAndCanaryWeight = percentageWithMuliplier / 2
   const stableDeploymentWeight = 1000 - percentageWithMuliplier

   core.debug(
      'Creating the traffic object with canary weight: ' +
         baselineAndCanaryWeight +
         ', baseline weight: ' +
         baselineAndCanaryWeight +
         ', stable weight: ' +
         stableDeploymentWeight
   )
   return await createTrafficSplitManifestFile(
      kubectl,
      serviceName,
      stableDeploymentWeight,
      baselineAndCanaryWeight,
      baselineAndCanaryWeight
   )
}

async function createTrafficSplitManifestFile(
   kubectl: Kubectl,
   serviceName: string,
   stableWeight: number,
   baselineWeight: number,
   canaryWeight: number,
   timeout?: string
): Promise<string> {
   const smiObjectString = await getTrafficSplitObject(
      kubectl,
      serviceName,
      stableWeight,
      baselineWeight,
      canaryWeight,
      timeout
   )
   const manifestFile = fileHelper.writeManifestToFile(
      smiObjectString,
      TRAFFIC_SPLIT_OBJECT,
      serviceName
   )

   if (!manifestFile) {
      throw new Error('Unable to create traffic split manifest file')
   }

   return manifestFile
}

let trafficSplitAPIVersion = ''

async function getTrafficSplitObject(
   kubectl: Kubectl,
   name: string,
   stableWeight: number,
   baselineWeight: number,
   canaryWeight: number,
   timeout?: string
): Promise<string> {
   // cached version
   if (!trafficSplitAPIVersion) {
      trafficSplitAPIVersion =
         await kubectlUtils.getTrafficSplitAPIVersion(kubectl)
   }

   return JSON.stringify({
      apiVersion: trafficSplitAPIVersion,
      kind: 'TrafficSplit',
      metadata: {
         name: getTrafficSplitResourceName(name),
         annotations: inputAnnotations
      },
      spec: {
         backends: [
            {
               service: canaryDeploymentHelper.getStableResourceName(name),
               weight: stableWeight
            },
            {
               service: canaryDeploymentHelper.getBaselineResourceName(name),
               weight: baselineWeight
            },
            {
               service: canaryDeploymentHelper.getCanaryResourceName(name),
               weight: canaryWeight
            }
         ],
         service: name
      }
   })
}

function getTrafficSplitResourceName(name: string) {
   return name + TRAFFIC_SPLIT_OBJECT_NAME_SUFFIX
}
