import { effect, ReactiveEffect, trigger, track } from './effect'
import { TriggerOpTypes, TrackOpTypes } from './operations'
import { Ref } from './ref'
import { isFunction, NOOP } from '@vue/shared'
import { ReactiveFlags, toRaw } from './reactive'

export interface ComputedRef<T = any> extends WritableComputedRef<T> {
  readonly value: T
}

export interface WritableComputedRef<T> extends Ref<T> {
  readonly effect: ReactiveEffect<T>
}

export type ComputedGetter<T> = (ctx?: any) => T
export type ComputedSetter<T> = (v: T) => void

export interface WritableComputedOptions<T> {
  get: ComputedGetter<T>
  set: ComputedSetter<T>
}

class ComputedRefImpl<T> {
  // 计算属性的值(缓存)
  private _value!: T
  // 标记值是否需要更新
  private _dirty = true

  public readonly effect: ReactiveEffect<T>

  public readonly __v_isRef = true;
  public readonly [ReactiveFlags.IS_READONLY]: boolean

  constructor(
    getter: ComputedGetter<T>,
    private readonly _setter: ComputedSetter<T>,
    isReadonly: boolean
  ) {
    // 创建effect
    // lazy: true标识这个effect不会立刻执行
    // 也就是计算属性在用到时才会执行
    this.effect = effect(getter, {
      lazy: true,
      // scheduler会在computed内部依赖的数据变化时执行(本来是会重新执行effect(这里是getter)的，但是设置了scheduler后会执行scheduler)
      // 只要把_dirty标识为true，然后触发更新(通知所有依赖于这个computed的effect更新)
      // 触发effect更新后，那些effect里会重新获取computed的值 也就走到了get value函数
      // 在get value函数中 因为dirty为true, 会触发getter的重新执行
      scheduler: () => {
        if (!this._dirty) {
          this._dirty = true
          trigger(toRaw(this), TriggerOpTypes.SET, 'value')
        }
      }
    })

    this[ReactiveFlags.IS_READONLY] = isReadonly
  }

  get value() {
    // the computed ref may get wrapped by other proxies e.g. readonly() #3376
    const self = toRaw(this)
    // 如果_dirty为true
    if (self._dirty) {
      // 重新执行effect, 也就是执行getter, 会同时把计算属性的effect设置为activeEffect并开启依赖收集
      // 更新计算属性的值
      self._value = this.effect()
      // 标记dirty为false
      self._dirty = false
    }
    // 收集依赖 也就是收集哪些effect依赖了这个computed对象
    track(self, TrackOpTypes.GET, 'value')
    return self._value
  }

  set value(newValue: T) {
    this._setter(newValue)
  }
}

export function computed<T>(getter: ComputedGetter<T>): ComputedRef<T>
export function computed<T>(
  options: WritableComputedOptions<T>
): WritableComputedRef<T>

// 实现computed
/**
 *
 * @param getterOrOptions 传入getter函数或者一个配置
 */
export function computed<T>(
  getterOrOptions: ComputedGetter<T> | WritableComputedOptions<T>
) {
  let getter: ComputedGetter<T>
  let setter: ComputedSetter<T>
  // 类型校验
  // 规格化成getter和setter再传入
  if (isFunction(getterOrOptions)) {
    getter = getterOrOptions
    setter = __DEV__
      ? () => {
          console.warn('Write operation failed: computed value is readonly')
        }
      : NOOP
  } else {
    getter = getterOrOptions.get
    setter = getterOrOptions.set
  }
  // 创建ComputedRef
  return new ComputedRefImpl(
    getter,
    setter,
    isFunction(getterOrOptions) || !getterOrOptions.set
  ) as any
}
