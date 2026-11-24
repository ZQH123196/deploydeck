import { ConfigError } from '../errors.js'
import type { Provider } from './provider.js'

/** provider 注册表。按 id 查找，不按厂商名分支。 */
export class ProviderRegistry {
  readonly #providers = new Map<string, Provider>()

  register(provider: Provider): void {
    if (this.#providers.has(provider.id)) {
      throw new ConfigError(`provider 重复注册：${provider.id}`)
    }
    this.#providers.set(provider.id, provider)
  }

  /** 取不到即抛错，不返回 undefined。 */
  require(id: string): Provider {
    const provider = this.#providers.get(id)
    if (provider === undefined) {
      const known = [...this.#providers.keys()].join(', ')
      throw new ConfigError(`未知 provider：${id}。已注册：${known}`)
    }
    return provider
  }

  list(): readonly Provider[] {
    return [...this.#providers.values()]
  }
}
