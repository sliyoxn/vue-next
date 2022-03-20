import { ElementWithTransition } from '../components/Transition'

// compiler should normalize class + :class bindings on the same element
// into a single binding ['staticClass', dynamic]
/**
 * 用于更新class
 * @param el
 * @param value
 * @param isSVG
 */
export function patchClass(el: Element, value: string | null, isSVG: boolean) {
  // 空值的话把class置为''
  if (value == null) {
    value = ''
  }
  if (isSVG) {
    el.setAttribute('class', value)
  } else {
    // 没看懂干嘛的 以后再说
    // directly setting className should be faster than setAttribute in theory
    // if this is an element during a transition, take the temporary transition
    // classes into account.
    const transitionClasses = (el as ElementWithTransition)._vtc
    if (transitionClasses) {
      value = (value
        ? [value, ...transitionClasses]
        : [...transitionClasses]
      ).join(' ')
    }
    // 直接设置就行
    el.className = value
  }
}
