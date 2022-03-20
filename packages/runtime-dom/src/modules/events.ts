import { hyphenate, isArray } from '@vue/shared'
import {
  ComponentInternalInstance,
  callWithAsyncErrorHandling
} from '@vue/runtime-core'
import { ErrorCodes } from 'packages/runtime-core/src/errorHandling'

interface Invoker extends EventListener {
  value: EventValue
  attached: number
}

type EventValue = Function | Function[]

// Async edge case fix requires storing an event listener's attach timestamp.
let _getNow: () => number = Date.now

let skipTimestampCheck = false

if (typeof window !== 'undefined') {
  // Determine what event timestamp the browser is using. Annoyingly, the
  // timestamp can either be hi-res (relative to page load) or low-res
  // (relative to UNIX epoch), so in order to compare time we have to use the
  // same timestamp type when saving the flush timestamp.
  if (_getNow() > document.createEvent('Event').timeStamp) {
    // if the low-res timestamp which is bigger than the event timestamp
    // (which is evaluated AFTER) it means the event is using a hi-res timestamp,
    // and we need to use the hi-res version for event listeners as well.
    _getNow = () => performance.now()
  }
  // #3485: Firefox <= 53 has incorrect Event.timeStamp implementation
  // and does not fire microtasks in between event propagation, so safe to exclude.
  const ffMatch = navigator.userAgent.match(/firefox\/(\d+)/i)
  skipTimestampCheck = !!(ffMatch && Number(ffMatch[1]) <= 53)
}

// To avoid the overhead of repeatedly calling performance.now(), we cache
// and use the same timestamp for all event listeners attached in the same tick.
let cachedNow: number = 0
const p = Promise.resolve()
const reset = () => {
  cachedNow = 0
}
const getNow = () => cachedNow || (p.then(reset), (cachedNow = _getNow()))

export function addEventListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions
) {
  el.addEventListener(event, handler, options)
}

export function removeEventListener(
  el: Element,
  event: string,
  handler: EventListener,
  options?: EventListenerOptions
) {
  el.removeEventListener(event, handler, options)
}

/**
 * 用于处理函数变化的情况
 * @param el
 * @param rawName 事件名
 * @param prevValue
 * @param nextValue
 * @param instance
 */
export function patchEvent(
  el: Element & { _vei?: Record<string, Invoker | undefined> },
  rawName: string,
  prevValue: EventValue | null,
  nextValue: EventValue | null,
  instance: ComponentInternalInstance | null = null
) {
  // vei = vue event invokers
  // 标识这个元素上所有的事件调用
  const invokers = el._vei || (el._vei = {})
  // 查看事件invokers是否存在
  const existingInvoker = invokers[rawName]
  // 如果事件invokers存在
  if (nextValue && existingInvoker) {
    // patch
    // 直接设置invokers的value属性
    existingInvoker.value = nextValue
  } else {
    // 这个name应该是事件名 options应该是.lazy这些修饰符
    const [name, options] = parseName(rawName)
    // 如果事件invokers不存在
    if (nextValue) {
      // add
      // 创建一个invokers
      const invoker = (invokers[rawName] = createInvoker(nextValue, instance))
      // 通过addEventListener api绑定invoker为事件处理
      addEventListener(el, name, invoker, options)
    } else if (existingInvoker) {
      // remove
      // 通过removeEventListener移除事件
      removeEventListener(el, name, existingInvoker, options)
      invokers[rawName] = undefined
    }
  }
}

const optionsModifierRE = /(?:Once|Passive|Capture)$/

function parseName(name: string): [string, EventListenerOptions | undefined] {
  let options: EventListenerOptions | undefined
  if (optionsModifierRE.test(name)) {
    options = {}
    let m
    while ((m = name.match(optionsModifierRE))) {
      name = name.slice(0, name.length - m[0].length)
      ;(options as any)[m[0].toLowerCase()] = true
      options
    }
  }
  return [hyphenate(name.slice(2)), options]
}

/**
 * Invoker是一个函数 因为直接给元素通过addEventListener绑定函数 在后续改绑or删除时不好删
 * 所以就用Invoker作为一个中间者，在invoker里执行绑定的函数(也就是.value属性)，但是给元素始终绑定的是invoker
 * @param initialValue
 * @param instance
 */
function createInvoker(
  initialValue: EventValue,
  instance: ComponentInternalInstance | null
) {
  const invoker: Invoker = (e: Event) => {
    // async edge case #6566: inner click event triggers patch, event handler
    // attached to outer element during patch, and triggered again. This
    // happens because browsers fire microtask ticks between event propagation.
    // the solution is simple: we save the timestamp when a handler is attached,
    // and the handler would only fire if the event passed to it was fired
    // AFTER it was attached.
    const timeStamp = e.timeStamp || _getNow()

    if (skipTimestampCheck || timeStamp >= invoker.attached - 1) {
      callWithAsyncErrorHandling(
        patchStopImmediatePropagation(e, invoker.value),
        instance,
        ErrorCodes.NATIVE_EVENT_HANDLER,
        [e]
      )
    }
  }
  invoker.value = initialValue
  invoker.attached = getNow()
  return invoker
}

function patchStopImmediatePropagation(
  e: Event,
  value: EventValue
): EventValue {
  if (isArray(value)) {
    const originalStop = e.stopImmediatePropagation
    e.stopImmediatePropagation = () => {
      originalStop.call(e)
      ;(e as any)._stopped = true
    }
    return value.map(fn => (e: Event) => !(e as any)._stopped && fn(e))
  } else {
    return value
  }
}
