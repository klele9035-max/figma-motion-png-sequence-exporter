const PREFERENCES_KEY = 'animation-ms-frame-export-v1'

figma.showUI(__html__, {
  width: 440,
  height: 660,
  themeColors: true,
})

function post(message) {
  figma.ui.postMessage(message)
}

function finiteNumber(value, label) {
  const number = Number(value)
  if (!Number.isFinite(number)) throw new Error(label + '必须是有效数字。')
  return number
}

function topLevelFrameFor(node) {
  if (!node) return null
  if (node.type === 'FRAME' && node.parent && node.parent.type === 'PAGE') return node
  if (typeof node.getTopLevelFrame === 'function') {
    const frame = node.getTopLevelFrame()
    if (frame && frame.type === 'FRAME' && frame.parent && frame.parent.type === 'PAGE') return frame
  }
  let current = node
  while (current && current.parent && current.parent.type !== 'PAGE') current = current.parent
  return current && current.type === 'FRAME' ? current : null
}

function timelineDurationMs(frame) {
  try {
    const timelines = frame && frame.timelines
    if (timelines && timelines.length && Number.isFinite(timelines[0].duration)) {
      return Math.max(0, Math.round(timelines[0].duration * 1000))
    }
  } catch (_) {}
  return 0
}

function playheadMs() {
  try {
    const value = figma.motion && figma.motion.playheadPosition
    return Number.isFinite(value) ? Math.max(0, Math.round(value * 1000)) : null
  } catch (_) {
    return null
  }
}

function cropFor(node, frame) {
  if (node === frame) {
    return { x: 0, y: 0, width: frame.width, height: frame.height }
  }
  const frameBounds = frame.absoluteBoundingBox
  const nodeBounds = node.absoluteBoundingBox
  if (!frameBounds || !nodeBounds) {
    throw new Error('无法计算所选 Group 在动画画框中的导出区域。请改选顶层 Frame。')
  }
  const x = nodeBounds.x - frameBounds.x
  const y = nodeBounds.y - frameBounds.y
  const left = Math.max(0, x)
  const top = Math.max(0, y)
  const right = Math.min(frame.width, x + nodeBounds.width)
  const bottom = Math.min(frame.height, y + nodeBounds.height)
  if (!(right > left && bottom > top)) {
    throw new Error('所选 Group 不在顶层动画 Frame 的可见范围内。')
  }
  return { x: left, y: top, width: right - left, height: bottom - top }
}

function inspectSelection() {
  const selection = figma.currentPage.selection
  if (selection.length !== 1) {
    post({
      type: 'selection-info',
      valid: false,
      message: selection.length ? '请只选择一个 Frame 或 Group。' : '请先选择一个带动画的 Frame 或 Group。',
      playheadMs: playheadMs(),
    })
    return
  }
  const node = selection[0]
  if (node.type !== 'FRAME' && node.type !== 'GROUP') {
    post({
      type: 'selection-info',
      valid: false,
      message: '当前选择是 ' + node.type + '，请选择 Frame 或 Group。',
      playheadMs: playheadMs(),
    })
    return
  }
  const frame = topLevelFrameFor(node)
  if (!frame) {
    post({
      type: 'selection-info',
      valid: false,
      message: '所选内容必须位于一个顶层动画 Frame 中。',
      playheadMs: playheadMs(),
    })
    return
  }
  const durationMs = timelineDurationMs(frame)
  post({
    type: 'selection-info',
    valid: durationMs > 0,
    message: durationMs > 0 ? '' : '没有在顶层 Frame 中检测到 Motion 动画时间轴。',
    nodeId: node.id,
    nodeName: node.name,
    nodeType: node.type,
    frameName: frame.name,
    durationMs,
    playheadMs: playheadMs(),
    isTopLevelFrame: node === frame,
  })
}

async function renderAnimation(message) {
  const selection = figma.currentPage.selection
  if (selection.length !== 1) throw new Error('请只选择一个 Frame 或 Group。')
  const node = selection[0]
  if (node.type !== 'FRAME' && node.type !== 'GROUP') throw new Error('请选择 Frame 或 Group。')
  const frame = topLevelFrameFor(node)
  if (!frame) throw new Error('所选内容必须位于一个顶层动画 Frame 中。')
  const durationMs = timelineDurationMs(frame)
  if (!(durationMs > 0)) throw new Error('没有检测到可导出的 Motion 动画时间轴。')

  if (!Array.isArray(message.times) || !message.times.length) throw new Error('没有要导出的时间点。')
  if (message.times.length > 1000) throw new Error('单次最多导出 1000 张 PNG。')
  const times = message.times.map(function (value) {
    const time = finiteNumber(value, '时间')
    if (time < 0 || time > durationMs) throw new Error('时间必须在 0–' + durationMs + ' ms 之间。')
    return time
  })

  const crop = cropFor(node, frame)
  let exportFrame = frame
  let temporaryFrame = null
  try {
    if (message.transparentBackground) {
      temporaryFrame = frame.clone()
      temporaryFrame.name = '__动画毫秒取帧_临时透明渲染__'
      temporaryFrame.x = frame.x + frame.width + 2000
      temporaryFrame.y = frame.y
      try { temporaryFrame.fills = [] } catch (_) {}
      exportFrame = temporaryFrame
    }

    post({ type: 'render-progress', phase: 'rendering', message: '正在由 Figma 渲染完整动画…' })
    const attempts = [
      { format: 'WEBM', mimeType: 'video/webm', fps: 60 },
      { format: 'MP4', mimeType: 'video/mp4', fps: 60 },
      { format: 'WEBM', mimeType: 'video/webm', fps: 30 },
      { format: 'MP4', mimeType: 'video/mp4', fps: 30 },
    ]
    let rendered = null
    const errors = []
    for (const attempt of attempts) {
      try {
        const bytes = await exportFrame.exportAsync({
          format: attempt.format,
          fps: attempt.fps,
          quality: 'HIGH',
        })
        rendered = {
          bytes,
          mimeType: attempt.mimeType,
          fps: attempt.fps,
          format: attempt.format,
        }
        break
      } catch (error) {
        errors.push(attempt.format + ' ' + attempt.fps + 'fps：' + (error && error.message ? error.message : String(error)))
      }
    }
    if (!rendered) {
      throw new Error('Figma 无法渲染这个动画 Frame。\n' + errors.join('\n'))
    }
    post({
      type: 'rendered-video',
      bytes: rendered.bytes,
      mimeType: rendered.mimeType,
      fps: rendered.fps,
      videoFormat: rendered.format,
      durationMs,
      frameWidth: frame.width,
      frameHeight: frame.height,
      crop,
      times,
      names: message.names,
      transparentBackground: Boolean(message.transparentBackground),
    })
  } finally {
    if (temporaryFrame && !temporaryFrame.removed) temporaryFrame.remove()
  }
}

figma.ui.onmessage = async function (message) {
  try {
    if (!message || !message.type) return
    if (message.type === 'inspect-selection') {
      inspectSelection()
      return
    }
    if (message.type === 'render-animation') {
      await renderAnimation(message)
      return
    }
    if (message.type === 'request-preferences') {
      const value = await figma.clientStorage.getAsync(PREFERENCES_KEY)
      post({ type: 'preferences', value: value || null })
      return
    }
    if (message.type === 'save-preferences') {
      await figma.clientStorage.setAsync(PREFERENCES_KEY, message.value || {})
      return
    }
    if (message.type === 'resize') {
      const width = Math.max(380, Math.min(760, Math.round(Number(message.width) || 440)))
      const height = Math.max(520, Math.min(920, Math.round(Number(message.height) || 660)))
      figma.ui.resize(width, height)
    }
  } catch (error) {
    post({
      type: 'plugin-error',
      message: error && error.message ? String(error.message) : String(error),
    })
  }
}

figma.on('selectionchange', inspectSelection)
inspectSelection()
