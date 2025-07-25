import {TrafficSplitObject} from '../../types/k8sObject'
import {Kubectl} from '../../types/kubectl'
import * as fileHelper from '../../utilities/fileUtils'
import * as TSutils from '../../utilities/trafficSplitUtils'

import {BlueGreenManifests} from '../../types/blueGreenTypes'
import {
   BLUE_GREEN_VERSION_LABEL,
   getManifestObjects,
   GREEN_LABEL_VALUE,
   NONE_LABEL_VALUE
} from './blueGreenHelper'

import {
   cleanupSMI,
   createTrafficSplitObject,
   getGreenSMIServiceResource,
   getStableSMIServiceResource,
   MAX_VAL,
   MIN_VAL,
   setupSMI,
   TRAFFIC_SPLIT_OBJECT,
   validateTrafficSplitsState
} from './smiBlueGreenHelper'
import * as bgHelper from './blueGreenHelper'

jest.mock('../../types/kubectl')

const kc = new Kubectl('')
const ingressFilepath = ['test/unit/manifests/test-ingress-new.yml']

// Shared mock objects following DRY principle
const mockSuccessResult = {
   stdout: 'service/nginx-service-stable created',
   stderr: '',
   exitCode: 0
}

const mockFailureResult = {
   stdout: '',
   stderr: 'error: service creation failed',
   exitCode: 1
}

const mockTsObject: TrafficSplitObject = {
   apiVersion: 'v1alpha3',
   kind: TRAFFIC_SPLIT_OBJECT,
   metadata: {
      name: 'nginx-service-trafficsplit',
      labels: new Map<string, string>(),
      annotations: new Map<string, string>()
   },
   spec: {
      service: 'nginx-service',
      backends: [
         {
            service: 'nginx-service-stable',
            weight: MIN_VAL
         },
         {
            service: 'nginx-service-green',
            weight: MAX_VAL
         }
      ]
   }
}

describe('SMI Helper tests', () => {
   let testObjects: BlueGreenManifests
   beforeEach(() => {
      //@ts-ignore
      Kubectl.mockClear()

      jest
         .spyOn(TSutils, 'getTrafficSplitAPIVersion')
         .mockImplementation(() => Promise.resolve(''))

      testObjects = getManifestObjects(ingressFilepath)
      jest
         .spyOn(fileHelper, 'writeObjectsToFile')
         .mockImplementationOnce(() => [''])
   })

   test('setupSMI tests', async () => {
      jest.spyOn(kc, 'apply').mockResolvedValue(mockSuccessResult)

      const smiResults = await setupSMI(kc, testObjects.serviceEntityList)

      let found = 0
      for (const obj of smiResults.objects) {
         if (obj.metadata.name === 'nginx-service-stable') {
            expect(obj.metadata.labels[BLUE_GREEN_VERSION_LABEL]).toBe(
               NONE_LABEL_VALUE
            )
            expect(obj.spec.selector.app).toBe('nginx')
            found++
         }

         if (obj.metadata.name === 'nginx-service-green') {
            expect(obj.metadata.labels[BLUE_GREEN_VERSION_LABEL]).toBe(
               GREEN_LABEL_VALUE
            )
            found++
         }

         if (obj.metadata.name === 'nginx-service-trafficsplit') {
            found++
            // expect stable weight to be max val
            const casted = obj as TrafficSplitObject
            expect(casted.spec.backends).toHaveLength(2)
            for (const be of casted.spec.backends) {
               if (be.service === 'nginx-service-stable') {
                  expect(be.weight).toBe(MAX_VAL)
               }
               if (be.service === 'nginx-service-green') {
                  expect(be.weight).toBe(MIN_VAL)
               }
            }
         }
      }

      expect(found).toBe(3)
   })

   test('createTrafficSplitObject tests', async () => {
      const noneTsObject: TrafficSplitObject = await createTrafficSplitObject(
         kc,
         testObjects.serviceEntityList[0].metadata.name,
         NONE_LABEL_VALUE
      )
      expect(noneTsObject.metadata.name).toBe('nginx-service-trafficsplit')
      for (let be of noneTsObject.spec.backends) {
         if (be.service === 'nginx-service-stable') {
            expect(be.weight).toBe(MAX_VAL)
         }
         if (be.service === 'nginx-service-green') {
            expect(be.weight).toBe(MIN_VAL)
         }
      }

      const greenTsObject: TrafficSplitObject = await createTrafficSplitObject(
         kc,
         testObjects.serviceEntityList[0].metadata.name,
         GREEN_LABEL_VALUE
      )
      expect(greenTsObject.metadata.name).toBe('nginx-service-trafficsplit')
      for (const be of greenTsObject.spec.backends) {
         if (be.service === 'nginx-service-stable') {
            expect(be.weight).toBe(MIN_VAL)
         }
         if (be.service === 'nginx-service-green') {
            expect(be.weight).toBe(MAX_VAL)
         }
      }
   })

   test('getSMIServiceResource test', () => {
      const stableResult = getStableSMIServiceResource(
         testObjects.serviceEntityList[0]
      )
      const greenResult = getGreenSMIServiceResource(
         testObjects.serviceEntityList[0]
      )

      expect(stableResult.metadata.name).toBe('nginx-service-stable')
      expect(stableResult.metadata.labels[BLUE_GREEN_VERSION_LABEL]).toBe(
         NONE_LABEL_VALUE
      )

      expect(greenResult.metadata.name).toBe('nginx-service-green')
      expect(greenResult.metadata.labels[BLUE_GREEN_VERSION_LABEL]).toBe(
         GREEN_LABEL_VALUE
      )
   })

   test('validateTrafficSplitsState', async () => {
      jest
         .spyOn(bgHelper, 'fetchResource')
         .mockImplementation(() => Promise.resolve(mockTsObject))

      let valResult = await validateTrafficSplitsState(
         kc,
         testObjects.serviceEntityList
      )

      expect(valResult).toBe(true)

      const mockTsCopy = JSON.parse(JSON.stringify(mockTsObject))
      mockTsCopy.spec.backends[0].weight = MAX_VAL
      jest
         .spyOn(bgHelper, 'fetchResource')
         .mockImplementation(() => Promise.resolve(mockTsCopy))

      valResult = await validateTrafficSplitsState(
         kc,
         testObjects.serviceEntityList
      )
      expect(valResult).toBe(false)

      jest.spyOn(bgHelper, 'fetchResource').mockImplementation()
      valResult = await validateTrafficSplitsState(
         kc,
         testObjects.serviceEntityList
      )
      expect(valResult).toBe(false)
   })

   test('cleanupSMI test', async () => {
      const deleteObjects = await cleanupSMI(kc, testObjects.serviceEntityList)
      expect(deleteObjects).toHaveLength(1)
      expect(deleteObjects[0].name).toBe('nginx-service-green')
      expect(deleteObjects[0].kind).toBe('Service')
   })

   // Consolidated error tests using test.each for DRY principle
   test.each([
      {
         name: 'should throw error when kubectl apply fails during SMI setup',
         fn: () => setupSMI(kc, testObjects.serviceEntityList),
         setup: () => {
            jest.spyOn(kc, 'apply').mockResolvedValue(mockFailureResult)
         }
      }
   ])('$name', async ({fn, setup}) => {
      setup()

      await expect(fn()).rejects.toThrow()
   })

   // Timeout-specific tests
   test('setupSMI with timeout test', async () => {
      const deployObjectsSpy = jest
         .spyOn(bgHelper, 'deployObjects')
         .mockResolvedValue({
            execResult: mockSuccessResult,
            manifestFiles: []
         })

      const timeout = '300s'
      const smiResults = await setupSMI(
         kc,
         testObjects.serviceEntityList,
         timeout
      )

      // Verify deployObjects was called with timeout
      expect(deployObjectsSpy).toHaveBeenCalledWith(
         kc,
         expect.any(Array),
         timeout
      )

      expect(smiResults.objects).toBeDefined()
      expect(smiResults.deployResult).toBeDefined()

      deployObjectsSpy.mockRestore()
   })

   test('createTrafficSplitObject with timeout test', async () => {
      const deleteObjectsSpy = jest
         .spyOn(bgHelper, 'deleteObjects')
         .mockResolvedValue()

      const timeout = '180s'
      const tsObject = await createTrafficSplitObject(
         kc,
         testObjects.serviceEntityList[0].metadata.name,
         NONE_LABEL_VALUE,
         timeout
      )

      // Verify deleteObjects was called with timeout
      expect(deleteObjectsSpy).toHaveBeenCalledWith(
         kc,
         expect.arrayContaining([
            expect.objectContaining({
               name: 'nginx-service-trafficsplit',
               kind: TRAFFIC_SPLIT_OBJECT
            })
         ]),
         timeout
      )

      expect(tsObject.metadata.name).toBe('nginx-service-trafficsplit')
      expect(tsObject.spec.backends).toHaveLength(2)

      deleteObjectsSpy.mockRestore()
   })

   test('createTrafficSplitObject with GREEN_LABEL_VALUE and timeout test', async () => {
      const deleteObjectsSpy = jest
         .spyOn(bgHelper, 'deleteObjects')
         .mockResolvedValue()

      const timeout = '240s'
      const tsObject = await createTrafficSplitObject(
         kc,
         testObjects.serviceEntityList[0].metadata.name,
         GREEN_LABEL_VALUE,
         timeout
      )

      // Verify deleteObjects was called with timeout
      expect(deleteObjectsSpy).toHaveBeenCalledWith(
         kc,
         expect.any(Array),
         timeout
      )

      // Verify weights are correct for green deployment
      for (const be of tsObject.spec.backends) {
         if (be.service === 'nginx-service-stable') {
            expect(be.weight).toBe(MIN_VAL)
         }
         if (be.service === 'nginx-service-green') {
            expect(be.weight).toBe(MAX_VAL)
         }
      }

      deleteObjectsSpy.mockRestore()
   })

   test('cleanupSMI with timeout test', async () => {
      const deleteObjectsSpy = jest
         .spyOn(bgHelper, 'deleteObjects')
         .mockResolvedValue()

      const timeout = '120s'
      const deleteObjects = await cleanupSMI(
         kc,
         testObjects.serviceEntityList,
         timeout
      )

      // Verify deleteObjects was called with timeout
      expect(deleteObjectsSpy).toHaveBeenCalledWith(
         kc,
         expect.arrayContaining([
            expect.objectContaining({
               name: 'nginx-service-green',
               kind: 'Service'
            })
         ]),
         timeout
      )

      expect(deleteObjects).toHaveLength(1)
      expect(deleteObjects[0].name).toBe('nginx-service-green')
      expect(deleteObjects[0].kind).toBe('Service')

      deleteObjectsSpy.mockRestore()
   })

   test('setupSMI without timeout test', async () => {
      const deployObjectsSpy = jest
         .spyOn(bgHelper, 'deployObjects')
         .mockResolvedValue({
            execResult: mockSuccessResult,
            manifestFiles: []
         })

      const smiResults = await setupSMI(kc, testObjects.serviceEntityList)

      // Verify deployObjects was called without timeout (undefined)
      expect(deployObjectsSpy).toHaveBeenCalledWith(
         kc,
         expect.any(Array),
         undefined
      )

      expect(smiResults.objects).toBeDefined()
      expect(smiResults.deployResult).toBeDefined()

      deployObjectsSpy.mockRestore()
   })

   test('createTrafficSplitObject without timeout test', async () => {
      const deleteObjectsSpy = jest
         .spyOn(bgHelper, 'deleteObjects')
         .mockResolvedValue()

      const tsObject = await createTrafficSplitObject(
         kc,
         testObjects.serviceEntityList[0].metadata.name,
         NONE_LABEL_VALUE
      )

      // Verify deleteObjects was called without timeout (undefined)
      expect(deleteObjectsSpy).toHaveBeenCalledWith(
         kc,
         expect.any(Array),
         undefined
      )

      expect(tsObject.metadata.name).toBe('nginx-service-trafficsplit')

      deleteObjectsSpy.mockRestore()
   })

   test('cleanupSMI without timeout test', async () => {
      const deleteObjectsSpy = jest
         .spyOn(bgHelper, 'deleteObjects')
         .mockResolvedValue()

      const deleteObjects = await cleanupSMI(kc, testObjects.serviceEntityList)

      // Verify deleteObjects was called without timeout (undefined)
      expect(deleteObjectsSpy).toHaveBeenCalledWith(
         kc,
         expect.any(Array),
         undefined
      )

      expect(deleteObjects).toHaveLength(1)

      deleteObjectsSpy.mockRestore()
   })
})
