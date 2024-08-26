import { app } from '../../scripts/app'
import { api } from '../../scripts/api'
import {
  LiteGraph,
  LGraphNode,
  LLink,
  INodeOutputSlot,
  INodeInputSlot
} from '@comfyorg/litegraph'
import { ComfyNodeDef } from '@/types/apiTypes'

let lastRequest: number = 0
let requestIdGen: number = 0
async function updateDynamicTypes(object_info) {
  for (const [nodeId, nodeData] of Object.entries(object_info)) {
    // Convert the key to a number
    const node = app.graph.getNodeById(parseInt(nodeId))
    if (!node) {
      console.error('Node not found:', nodeId)
      continue
    }
    // @ts-expect-error
    node.UpdateDynamicNodeTypes(nodeData)
  }
}

function debounce(
  func: Function,
  nonDebounced: Function,
  prefixMs: number,
  postfixMs: number
) {
  let timeout: NodeJS.Timeout | null = null
  let queued: Boolean = false
  let lastArgs: any[] = []
  let handle = () => {
    if (queued) {
      func(...lastArgs)
      queued = false
    }
  }
  return (...args: any[]) => {
    if (nonDebounced) {
      nonDebounced(...args)
    }
    if (timeout) {
      lastArgs = args
      queued = true
    } else {
      lastArgs = args
      queued = true
      timeout = setTimeout(() => {
        handle()
        timeout = setTimeout(() => {
          handle()
          timeout = null
        }, postfixMs)
      }, prefixMs)
    }
  }
}

const resolveDynamicTypes = debounce(
  async () => {
    let currentRequest = requestIdGen
    lastRequest = currentRequest
    const p = await app.graphToPrompt()
    if (!('output' in p)) {
      console.log('Skipping dynamic type resolution -- no prompt found', p)
      return
    }
    const request = {
      client_id: api.clientId,
      prompt: p.output
    }
    const response = await api.fetchApi('/resolve_dynamic_types', {
      method: 'POST',
      body: JSON.stringify(request)
    })
    if (!response.ok) {
      console.error('Error:', response)
      return
    }
    const data = await response.json()
    if (lastRequest !== currentRequest) {
      console.log(
        'Skipping dynamic type resolution -- newer request in progress'
      )
      return
    }
    await updateDynamicTypes(data)
  },
  () => ++requestIdGen,
  5,
  500
)

// @ts-expect-error
const oldIsValidConnection = LiteGraph.isValidConnection
// @ts-expect-error
LiteGraph.isValidConnection = function (type1: str, type2: str) {
  if (oldIsValidConnection(type1, type2)) {
    return true
  }
  // If the character '*' is in either type, use a regex to check against the other type
  if (type1.includes('*')) {
    const re = new RegExp('^' + type1.replace(/\*/g, '.*') + '$')
    if (re.test(type2)) {
      return true
    }
  }
  if (type2.includes('*')) {
    const re = new RegExp('^' + type2.replace(/\*/g, '.*') + '$')
    if (re.test(type1)) {
      return true
    }
  }
  return false
}

app.registerExtension({
  name: 'Comfy.DynamicTyping',
  async beforeRegisterNodeDef(nodeType, nodeData, _) {
    const oldOnConnectInput = nodeType?.prototype?.onConnectInput
    nodeType.prototype.onConnectInput = function (
      slotIndex: number,
      type: string,
      link: LLink
    ) {
      if (oldOnConnectInput) {
        if (!oldOnConnectInput.call(this, slotIndex, type, link)) {
          return false
        }
      }
      return true
    }
    const oldOnConnectionsChange = nodeType?.prototype?.onConnectionsChange
    nodeType.prototype.onConnectionsChange = function (
      type: number,
      slotIndex: number,
      isConnected: boolean,
      link: LLink,
      ioSlot: INodeOutputSlot | INodeInputSlot
    ) {
      if (oldOnConnectionsChange) {
        oldOnConnectionsChange.call(
          this,
          type,
          slotIndex,
          isConnected,
          link,
          ioSlot
        )
      }
      resolveDynamicTypes()
    }
    nodeType.prototype.UpdateDynamicNodeTypes = function (
      this: LGraphNode,
      dynamicNodeData: ComfyNodeDef
    ) {
      // @ts-expect-error
      if (!this.nodeData) {
        // @ts-expect-error
        this.nodeData = nodeData
      }
      const inputs = Object.assign(
        {},
        dynamicNodeData['input']['required'],
        dynamicNodeData['input']['optional'] ?? {}
      )
      const inputs_to_remove = []
      for (const { name } of this.inputs) {
        // Handle removed inputs
        if (!(name in inputs)) {
          inputs_to_remove.push(name)
          continue
        }
        // Handle the changing of input types
        const slot = this.findInputSlot(name)
        if (slot !== -1 && this.inputs[slot].type !== inputs[name][0]) {
          if (!inputs[name][1]?.forceInput) {
            throw new Error('Dynamic inputs must have forceInput set')
          }
          if (slot !== -1) {
            this.inputs[slot].type = inputs[name][0]
            // Update any links with the type
            if (this.inputs[slot].link) {
              let link = this.graph.links[this.inputs[slot].link]
              link.type = inputs[name][0]
            }
          }
        }
      }
      for (const name of inputs_to_remove) {
        const slot = this.findInputSlot(name)
        if (slot !== -1) {
          this.removeInput(slot)
        }
      }
      let inputOrder = {}
      for (const [inputName, inputInfo] of Object.entries(inputs)) {
        // Handle new inputs
        if (this.findInputSlot(inputName) === -1) {
          if (inputInfo[1]?.forceInput) {
            this.addInput(inputName, inputInfo[0])
          }
        }
        // Store off explicit sort order
        if (inputInfo[1]?.displayOrder) {
          inputOrder[inputName] = inputInfo[1].displayOrder
        }
      }
      this.inputs.sort((a, b) => {
        const aOrder = inputOrder[a.name] ?? 0
        const bOrder = inputOrder[b.name] ?? 0
        return aOrder - bOrder
      })

      const outputNames = dynamicNodeData['output_name']
      const outputTypes: string[] = dynamicNodeData['output'].map((x) => {
        if (typeof x === 'string') {
          return x
        } else {
          return 'COMBO'
        }
      })
      const outputs_to_remove = []
      for (const { name } of this.outputs) {
        // Handle removed outputs
        if (!outputNames.includes(name)) {
          outputs_to_remove.push(name)
          continue
        }
        // Handle the changing of output types
        const outputIndex = outputNames.indexOf(name)
        const outputSlot = this.findOutputSlot(name)
        if (
          outputSlot !== -1 &&
          this.outputs[outputSlot].type !== outputTypes[outputIndex]
        ) {
          this.outputs[outputSlot].type = outputTypes[outputIndex]
          if (this.outputs[outputSlot].links) {
            for (const linkId of this.outputs[outputSlot].links) {
              let link = this.graph.links[linkId]
              link.type = outputTypes[outputIndex]
            }
          }
        }
      }
      for (const name of outputs_to_remove) {
        const slot = this.findOutputSlot(name)
        if (slot !== -1) {
          this.removeOutput(slot)
        }
      }
      for (const [i, outputName] of Object.entries(outputNames)) {
        // Handle new outputs
        const slot = this.findOutputSlot(outputName)
        if (slot !== -1) {
          continue
        }
        this.addOutput(outputName, outputTypes[i])
      }

      // @ts-expect-error
      this.nodeData = Object.assign({}, this.nodeData, dynamicNodeData)
      this.setDirtyCanvas(true, true)
    }
  }
})
