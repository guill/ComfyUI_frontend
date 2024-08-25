import { app } from '../../scripts/app'
import { api } from '../../scripts/api'
import { LLink, INodeOutputSlot, INodeInputSlot } from '@comfyorg/litegraph'
import { ComfyNodeDef } from '@/types/apiTypes'

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

function debounce(func: Function, periodMs: number) {
  let timeout: NodeJS.Timeout | null = null
  let queued: Boolean = false
  let lastArgs: any[] = []
  return (...args: any[]) => {
    if (timeout) {
      queued = true
      lastArgs = args
    } else {
      func(...args)
      queued = false
      timeout = setTimeout(() => {
        if (queued) {
          func(...lastArgs)
          queued = false
        }
        timeout = null
      }, periodMs)
    }
  }
}

const resolveDynamicTypes = debounce(async () => {
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
  await updateDynamicTypes(data)
}, 100)

app.registerExtension({
  name: 'Comfy.DynamicTyping',
  async beforeRegisterNodeDef(nodeType, nodeData, _) {
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
      dynamicNodeData: ComfyNodeDef
    ) {
      if (!this.nodeData) {
        this.nodeData = nodeData
      }
      const inputs = Object.assign(
        {},
        dynamicNodeData['input']['required'],
        dynamicNodeData['input']['optional'] ?? {}
      )
      const oldInputs = Object.assign(
        {},
        this.nodeData['input']['required'],
        this.nodeData['input']['optional'] ?? {}
      )
      const inputs_to_remove = []
      for (const { name } of this.inputs) {
        const inputInfo = oldInputs[name]
        // Handle removed inputs
        if (!(name in inputs)) {
          if (inputInfo && inputInfo[1] && !inputInfo[1].forceInput) {
            throw new Error('Dynamic inputs must have forceInput set')
          }
          inputs_to_remove.push(name)
          continue
        }
        if (!inputInfo) {
          continue
        }
        // Handle the changing of input types
        if (inputs[name][0] !== inputInfo[0]) {
          if (!inputInfo[1]?.forceInput) {
            throw new Error('Dynamic inputs must have forceInput set')
          }
          const slot = this.findInputSlot(name)
          if (slot !== -1) {
            this.inputs[slot].type = inputs[name][0]
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
      const oldOutputNames = this.nodeData['output_name']
      const outputTypes = dynamicNodeData['output']
      const oldOutputTypes = this.nodeData['output']
      const outputs_to_remove = []
      for (const { name } of this.outputs) {
        // Handle removed outputs
        if (!outputNames.includes(name)) {
          outputs_to_remove.push(name)
          continue
        }
        // Handle the changing of output types
        const outputIndex = outputNames.indexOf(name)
        const oldOutputIndex = oldOutputNames.indexOf(name)
        if (outputTypes[outputIndex] !== oldOutputTypes[oldOutputIndex]) {
          const slot = this.findOutputSlot(name)
          if (slot !== -1) {
            this.outputs[slot].type = outputTypes[outputIndex]
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

      this.nodeData = Object.assign({}, this.nodeData, dynamicNodeData)
      this.setDirtyCanvas(true, true)
    }
  }
})
