import { TrackOpTypes, TriggerOpTypes } from './operations'
import { EMPTY_OBJ, isArray, isIntegerKey, isMap } from '@vue/shared'

// The main WeakMap that stores {target -> key -> dep} connections.
// Conceptually, it's easier to think of a dependency as a Dep class
// which maintains a Set of subscribers, but we simply store them as
// raw Sets to reduce memory overhead.
// targetMap的数据类型
type Dep = Set<ReactiveEffect>
type KeyToDepMap = Map<any, Dep>
// 映射target和key到effect的map
const targetMap = new WeakMap<any, KeyToDepMap>()

export interface ReactiveEffect<T = any> {
  (): T
  _isEffect: true
  id: number
  active: boolean
  raw: () => T
  deps: Array<Dep>
  options: ReactiveEffectOptions
  allowRecurse: boolean
}

export interface ReactiveEffectOptions {
  lazy?: boolean
  scheduler?: (job: ReactiveEffect) => void
  onTrack?: (event: DebuggerEvent) => void
  onTrigger?: (event: DebuggerEvent) => void
  onStop?: () => void
  allowRecurse?: boolean
}

export type DebuggerEvent = {
  effect: ReactiveEffect
  target: object
  type: TrackOpTypes | TriggerOpTypes
  key: any
} & DebuggerEventExtraInfo

export interface DebuggerEventExtraInfo {
  newValue?: any
  oldValue?: any
  oldTarget?: Map<any, any> | Set<any>
}
// 在effect的fn中，有可能再调用effect
// 所以要用一个effect栈来保存历史的effect(保证对应关系)
const effectStack: ReactiveEffect[] = []
// 用于保存现在激活的effect
// 会在track中用到
// 其实就是Vue2的Dep.target
let activeEffect: ReactiveEffect | undefined

export const ITERATE_KEY = Symbol(__DEV__ ? 'iterate' : '')
export const MAP_KEY_ITERATE_KEY = Symbol(__DEV__ ? 'Map key iterate' : '')

export function isEffect(fn: any): fn is ReactiveEffect {
  return fn && fn._isEffect === true
}

// 定义effect函数
// 在getter中会收集effect调用的方法
// 在setter中会重新触发effect中调用的方法
export function effect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions = EMPTY_OBJ
): ReactiveEffect<T> {
  if (isEffect(fn)) {
    fn = fn.raw
  }
  // 创建一个响应式的effect
  const effect = createReactiveEffect(fn, options)
  // 默认的effect会先执行一次
  // 响应式的effect会走这个逻辑
  if (!options.lazy) {
    effect()
  }
  return effect
}

export function stop(effect: ReactiveEffect) {
  if (effect.active) {
    cleanup(effect)
    if (effect.options.onStop) {
      effect.options.onStop()
    }
    effect.active = false
  }
}

let uid = 0

/**
 * 创建响应式effect
 * @param fn
 * @param options
 */
function createReactiveEffect<T = any>(
  fn: () => T,
  options: ReactiveEffectOptions
): ReactiveEffect<T> {
  const effect = function reactiveEffect(): unknown {
    // 好像是调用了stop才会导致effect的active为false
    // 应该是为了停用effect吧
    if (!effect.active) {
      return options.scheduler ? undefined : fn()
    }
    // effectStack不包含当前的effect
    // 主要是为了有哈批写出这种代码: effect(() => {data.count++});
    if (!effectStack.includes(effect)) {
      // 每次重新执行effect都会再调用get方法
      // 这时候需要重新进行依赖收集
      // 因为有些时候重新执行后不再依赖某些依赖了，所以先clean一波
      // 比如effect(() => { if( data.name === 'Sakura' ) {console.log(data.age)} })
      cleanup(effect)
      try {
        // 开启追踪(其实就是改变个标识)
        enableTracking()
        // effect入栈
        effectStack.push(effect)
        // 存储激活的effect
        activeEffect = effect
        // 执行fn，如果这里用了proxy
        // proxy里的getter就可以获取到activeEffect
        // 从而进行依赖收集
        return fn()
      } finally {
        // effect出栈
        effectStack.pop()
        // 关闭追踪
        resetTracking()
        // 把激活的effect置为栈顶
        activeEffect = effectStack[effectStack.length - 1]
      }
    }
  } as ReactiveEffect
  // effect的唯一标识
  effect.id = uid++
  // 是否允许递归
  effect.allowRecurse = !!options.allowRecurse
  // 标识这个effect是否是响应式的effect
  effect._isEffect = true
  // 是否激活
  effect.active = true
  // 存储对应的原函数
  effect.raw = fn
  // effect的依赖
  // 比如一个effect里访问了data.name和data.age
  // 这里就会记录这些deps 用于之后的 stop
  effect.deps = []
  // effect的配置
  effect.options = options
  return effect
}

/**
 * 清空被收集的effect
 * @param effect
 */
function cleanup(effect: ReactiveEffect) {
  const { deps } = effect
  if (deps.length) {
    for (let i = 0; i < deps.length; i++) {
      deps[i].delete(effect)
    }
    deps.length = 0
  }
}

let shouldTrack = true
const trackStack: boolean[] = []

export function pauseTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = false
}

export function enableTracking() {
  trackStack.push(shouldTrack)
  shouldTrack = true
}

export function resetTracking() {
  const last = trackStack.pop()
  shouldTrack = last === undefined ? true : last
}

/**
 * 用于收集依赖
 * 会收集effect到deps里用于之后的触发
 * 可以根据target和key找到对应的deps
 * @param target 源对象
 * @param type 类型，貌似这里就是用来log的
 * @param key 属性
 */
export function track(target: object, type: TrackOpTypes, key: unknown) {
  // shouldTrack在enableTracking()里激活
  // activeEffect不存在就return
  if (!shouldTrack || activeEffect === undefined) {
    return
  }
  // 经典嵌套map
  // 先用target为key
  // depsMap还是一个map
  let depsMap = targetMap.get(target)
  if (!depsMap) {
    targetMap.set(target, (depsMap = new Map()))
  }
  // 找完target再用key作为key找
  // 找到依赖于这个target的所有effect
  // 这里的dep是一个Set
  let dep = depsMap.get(key)
  if (!dep) {
    depsMap.set(key, (dep = new Set()))
  }
  // 查找effect是否已经被收集
  // 如果没有就加入 虽然set本身就有去重的功能hhh
  if (!dep.has(activeEffect)) {
    dep.add(activeEffect)
    // 相互记录 让effect知道哪些的deps存储了这个effect
    // 用于之后的移除
    activeEffect.deps.push(dep)
    if (__DEV__ && activeEffect.options.onTrack) {
      activeEffect.options.onTrack({
        effect: activeEffect,
        target,
        type,
        key
      })
    }
  }
}

/**
 * 触发更新
 * @param target
 * @param type
 * @param key
 * @param newValue
 * @param oldValue
 * @param oldTarget
 */
export function trigger(
  target: object,
  type: TriggerOpTypes,
  key?: unknown,
  newValue?: unknown,
  oldValue?: unknown,
  oldTarget?: Map<unknown, unknown> | Set<unknown>
) {
  // 查看target有没有收集effect
  // depsMap的类型是Map<any, Dep>
  // Dep的类型是Set<ReactiveEffect>
  const depsMap = targetMap.get(target)
  if (!depsMap) {
    // never been tracked
    return
  }
  // 把要执行的effect放到一个集合中
  // 最终一起执行
  const effects = new Set<ReactiveEffect>()
  // 把target下某个属性的effect全部放入effects
  // 注意并不是用于添加单个effect的
  const add = (effectsToAdd: Set<ReactiveEffect> | undefined) => {
    if (effectsToAdd) {
      effectsToAdd.forEach(effect => {
        if (effect !== activeEffect || effect.allowRecurse) {
          effects.add(effect)
        }
      })
    }
  }

  if (type === TriggerOpTypes.CLEAR) {
    // 这个分支是清空某些集合的情况下触发的
    // 这时候会触发target上所有的effect
    // collection being cleared
    // trigger all effects for target
    depsMap.forEach(add)
  } else if (key === 'length' && isArray(target)) {
    // 如果对象是一个数组，且修改的是length，需要对依赖下标的effect进行触发
    // 比如下面的情况
    // effect(() => {app.innerHTML = data.arr[2]});
    depsMap.forEach((dep, key) => {
      // 把下标小于length的都添加进去
      if (key === 'length' || key >= (newValue as number)) {
        add(dep)
      }
    })
  } else {
    // schedule runs for SET | ADD | DELETE
    // 处理set | add| delete相关的逻辑

    // 添加对应属性的effect就行
    // void 0就是undefined
    // 不直接用undefined的原因是，undefined在局部作用域下可能会重新被赋值
    if (key !== void 0) {
      add(depsMap.get(key))
    }

    // also run for iteration key on ADD | DELETE | Map.SET
    // 分别处理对象的add delete set的迭代key？but没看懂迭代key是什么东东
    // 因为普通的effect在上面已经处理过了
    // 感觉这里是加一些其他的key依赖
    switch (type) {
      case TriggerOpTypes.ADD:
        // 新增属性
        if (!isArray(target)) {
          // 普通对象直接加
          add(depsMap.get(ITERATE_KEY))
          // 处理Map这个数据结构的 没看懂
          if (isMap(target)) {
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        } else if (isIntegerKey(key)) {
          // 如果是数组且key是数字下标
          // 还需要加入length的effect(因为数组新增下标肯定length变大了)
          // new index added to array -> length changes
          add(depsMap.get('length'))
        }
        break
      case TriggerOpTypes.DELETE:
        // 处理删除的逻辑
        if (!isArray(target)) {
          // 非数组 直接加
          add(depsMap.get(ITERATE_KEY))
          if (isMap(target)) {
            // 处理map 没看懂 以后再看
            add(depsMap.get(MAP_KEY_ITERATE_KEY))
          }
        }
        break
      case TriggerOpTypes.SET:
        // 处理set逻辑
        if (isMap(target)) {
          // 处理map数据结构
          add(depsMap.get(ITERATE_KEY))
        }
        break
    }
  }
  // 执行所有的effect
  const run = (effect: ReactiveEffect) => {
    // 应该是debug用的 先不管
    if (__DEV__ && effect.options.onTrigger) {
      effect.options.onTrigger({
        effect,
        target,
        key,
        type,
        newValue,
        oldValue,
        oldTarget
      })
    }
    // 调度
    // 默认情况下都是scheduler是undefined
    // 除非写代码时在options里传进去
    if (effect.options.scheduler) {
      effect.options.scheduler(effect)
    } else {
      // 一般会直接执行effect
      // 才发现没有合并执行了 估计是抽离出去了吧
      effect()
    }
  }

  effects.forEach(run)
}
