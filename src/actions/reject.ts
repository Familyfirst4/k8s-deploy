import * as core from '@actions/core'
import * as canaryDeploymentHelper from '../strategyHelpers/canary/canaryHelper'
import * as SMICanaryDeploymentHelper from '../strategyHelpers/canary/smiCanaryHelper'
import {Kubectl} from '../types/kubectl'
import {rejectBlueGreenService} from '../strategyHelpers/blueGreen/serviceBlueGreenHelper'
import {rejectBlueGreenIngress} from '../strategyHelpers/blueGreen/ingressBlueGreenHelper'
import {rejectBlueGreenSMI} from '../strategyHelpers/blueGreen/smiBlueGreenHelper'
import {DeploymentStrategy} from '../types/deploymentStrategy'
import {
   parseTrafficSplitMethod,
   TrafficSplitMethod
} from '../types/trafficSplitMethod'
import {parseRouteStrategy, RouteStrategy} from '../types/routeStrategy'

export async function reject(
   kubectl: Kubectl,
   manifests: string[],
   deploymentStrategy: DeploymentStrategy
) {
   switch (deploymentStrategy) {
      case DeploymentStrategy.CANARY:
         await rejectCanary(kubectl, manifests)
         break
      case DeploymentStrategy.BLUE_GREEN:
         await rejectBlueGreen(kubectl, manifests)
         break
      default:
         throw 'Invalid delete deployment strategy'
   }
}

async function rejectCanary(kubectl: Kubectl, manifests: string[]) {
   let includeServices = false

   const trafficSplitMethod = parseTrafficSplitMethod(
      core.getInput('traffic-split-method', {required: true})
   )
   if (trafficSplitMethod == TrafficSplitMethod.SMI) {
      core.info('Rejecting deployment with SMI canary strategy')
      includeServices = true
      await SMICanaryDeploymentHelper.redirectTrafficToStableDeployment(
         kubectl,
         manifests
      )
   }

   core.info('Deleting baseline and canary workloads')
   await canaryDeploymentHelper.deleteCanaryDeployment(
      kubectl,
      manifests,
      includeServices
   )
}

async function rejectBlueGreen(kubectl: Kubectl, manifests: string[]) {
   core.info('Rejecting deployment with blue green strategy')

   const routeStrategy = parseRouteStrategy(
      core.getInput('route-method', {required: true})
   )
   if (routeStrategy == RouteStrategy.INGRESS) {
      await rejectBlueGreenIngress(kubectl, manifests)
   } else if (routeStrategy == RouteStrategy.SMI) {
      await rejectBlueGreenSMI(kubectl, manifests)
   } else {
      await rejectBlueGreenService(kubectl, manifests)
   }
}
