/**
 * Register an {@link OpenAiCodexAdapter} for the `openai-codex` provider
 * route on `ctx.llm`. The route is dormant until an OAuth session is stored
 * under the configured `oauthEnv` reference; `/codex-login` and
 * {@link OpenAiCodexAuth.login} persist that session, and pi-ai refreshes it
 * on the next request under the store lock.
 *
 * @module @devteapot/dsh-openai-codex
 */

import { Context, Service } from '@deepseek-ai/cordis'
import type { AuthInteraction, Models } from '@earendil-works/pi-ai'
import { LlmError } from '@deepseek-ai/dsh-llm'
import type { AdapterRegistrationHandle } from '@deepseek-ai/dsh-llm'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import { deepEqualJson, installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import { createCodexModels, OpenAiCodexAdapter } from './adapter.ts'
import {
  Config,
  PROVIDER,
  resolveAdapterOptions,
  SETTINGS_NS,
} from './config.ts'
import type { ResolvedOpenAiCodexOptions } from './config.ts'
import { createCommandInteraction } from './login.ts'
import { createOAuthStore } from './store.ts'
import type { OAuthStoreAccess, OAuthStoreHooks } from './store.ts'

export { createCodexModels, OpenAiCodexAdapter } from './adapter.ts'
export type { OpenAiCodexAdapterOptions } from './adapter.ts'
export {
  Config,
  DEFAULT_DISPLAY_NAME,
  DEFAULT_OAUTH_ENV,
  DEFAULT_STREAM_IDLE_TIMEOUT_MS,
  PROVIDER,
  resolveAdapterOptions,
  SETTINGS_NS,
} from './config.ts'
export type { ResolvedOpenAiCodexOptions } from './config.ts'
export { createCommandInteraction } from './login.ts'
export { createOAuthStore, parseOAuthCredential, serializeOAuthCredential } from './store.ts'
export type { OAuthStoreAccess, OAuthStoreHooks } from './store.ts'

export const name = 'llm-openai-codex'
export const inject = ['llm']

const NS = settingsNamespace(SETTINGS_NS)

declare module '@deepseek-ai/cordis' {
  interface Context {
    openaiCodex: OpenAiCodexAuth
  }
}

/** Login, logout, and status for the ChatGPT OAuth session this plugin stores. */
export class OpenAiCodexAuth extends Service {
  constructor(
    ctx: Context,
    private readonly ops: {
      login: (interaction: AuthInteraction) => Promise<void>
      logout: () => Promise<void>
      status: () => Promise<{ configured: boolean }>
    },
  ) {
    super(ctx, 'openaiCodex')
  }

  /**
   * Run the Codex OAuth login and persist the returned session.
   * @param interaction - prompts and notifications the host UI implements.
   * @returns after the session is stored and the route is registered.
   */
  login(interaction: AuthInteraction): Promise<void> {
    return this.ops.login(interaction)
  }

  /**
   * Drop the stored session and withdraw the `openai-codex` route.
   * @returns after the credential is removed and the route is withdrawn.
   */
  logout(): Promise<void> {
    return this.ops.logout()
  }

  /**
   * Report whether a stored OAuth session currently exists.
   * @returns `{ configured: true }` when the store can read a session.
   */
  status(): Promise<{ configured: boolean }> {
    return this.ops.status()
  }
}

/**
 * Persistence hooks that read the OAuth session from `ctx.credentials` or the
 * launch environment, and write only through the credentials service.
 * @param ctx - context that may carry `credentials`.
 * @param options - current validated connection facts.
 * @returns hooks for {@link createOAuthStore}.
 */
export function createStoreHooks(ctx: Context, options: () => ResolvedOpenAiCodexOptions): OAuthStoreHooks {
  const access = (): OAuthStoreAccess => {
    const ref = options().oauthEnv
    const credentials = ctx.get('credentials')
    return {
      read: async () => {
        if (credentials !== undefined) return (await credentials.resolve(ref))?.value
        const ambient = launchEnvironmentOf(ctx).get(ref)
        if (ambient === undefined || ambient.value.length === 0) return undefined
        return ambient.value
      },
      write: async (value) => {
        if (credentials === undefined) {
          throw new LlmError(
            'llm-openai-codex: login needs the credentials service to store the OAuth session; mount dsh-credentials-local',
            'MISSING_CREDENTIAL',
          )
        }
        await credentials.set(ref, value)
      },
      unset: async () => {
        if (credentials === undefined) return
        await credentials.unset(ref)
      },
    }
  }
  return { access }
}

/**
 * Register the Codex adapter, OAuth service, and optional `/codex-login`
 * / `/codex-logout` commands.
 * @param ctx - context carrying `ctx.llm` and optional settings/credentials/commands.
 * @param config - composition entry config, used as the settings base.
 */
export function apply(ctx: Context, config: Config): void {
  let current: () => Config = () => config
  let lastRaw: Config | undefined
  let lastGood: ResolvedOpenAiCodexOptions | undefined
  const options = (): ResolvedOpenAiCodexOptions => {
    const raw = current()
    if (raw === lastRaw && lastGood !== undefined) return lastGood
    try {
      const next = resolveAdapterOptions(raw)
      lastRaw = raw
      lastGood = next
      return next
    } catch (error) {
      /* v8 ignore start -- validate refuses an unserviceable write; this keeps serving if one still lands. */
      if (lastGood === undefined) throw error
      lastRaw = raw
      ctx.logger.error('llm-openai-codex: keeping the last good configuration after an invalid settings section')
      ctx.logger.error(error)
      return lastGood
      /* v8 ignore stop */
    }
  }
  options()

  const store = createOAuthStore(createStoreHooks(ctx, options))
  const models: Models = createCodexModels(store)
  const adapter = new OpenAiCodexAdapter({
    options,
    models: () => models,
    /* v8 ignore next -- image requests on this instance hit it; text-only catalog models throw first */
    resolveAttachments: () => ctx.get('attachments'),
  })

  let registration: AdapterRegistrationHandle | undefined
  let registeredPolicy = options().retryPolicy
  let registeredDisplayName = options().displayName
  let registrationSync = Promise.resolve()
  let registrationClosed = false
  const ensureRegistration = async (): Promise<void> => {
    const facts = options()
    const listed = await store.list()
    if (registrationClosed) return
    const ready = listed.some(entry => entry.providerId === PROVIDER)
    const policyChanged = !deepEqualJson(facts.retryPolicy, registeredPolicy)
      || facts.displayName !== registeredDisplayName
    if (!ready) {
      if (registration !== undefined) {
        registration.replace([])
        registeredPolicy = facts.retryPolicy
        registeredDisplayName = facts.displayName
      }
      return
    }
    if (registration === undefined) {
      registration = ctx.llm.registerAdapter([PROVIDER], adapter)
    } else if (policyChanged) {
      registration.replace([PROVIDER])
    }
    registeredPolicy = facts.retryPolicy
    registeredDisplayName = facts.displayName
  }

  const syncRegistration = (): void => {
    void queueRegistration().catch((error: unknown) => {
      ctx.logger.error('llm-openai-codex: failed to refresh the openai-codex route')
      ctx.logger.error(error)
    })
  }

  const queueRegistration = (): Promise<void> => {
    if (registrationClosed) return Promise.resolve()
    const next = registrationSync.then(async () => {
      if (!registrationClosed) await ensureRegistration()
    })
    registrationSync = next.catch(() => undefined)
    return next
  }

  syncRegistration()
  ctx.on('credentials/updated', (ref) => {
    if (ref === options().oauthEnv) syncRegistration()
  })

  new OpenAiCodexAuth(ctx, {
    login: async (interaction) => {
      await models.login(PROVIDER, 'oauth', interaction)
      await queueRegistration()
    },
    logout: async () => {
      await models.logout(PROVIDER)
      await queueRegistration()
    },
    status: async () => {
      const listed = await store.list()
      return { configured: listed.some(entry => entry.providerId === PROVIDER) }
    },
  })

  ctx.inject(['commands'], (commandCtx) => {
    const active = new Set<Promise<unknown>>()
    const lifetime = new AbortController()
    const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error)
    const run = (operation: Promise<unknown>): Promise<unknown> => {
      active.add(operation)
      const retire = (): void => { active.delete(operation) }
      void operation.then(retire, retire)
      return operation
    }
    commandCtx.effect(function* () {
      yield async () => {
        lifetime.abort('llm-openai-codex commands disposed')
        await Promise.allSettled(active)
      }
      yield commandCtx.commands.register({
        name: 'codex-login',
        description: 'Sign in to OpenAI Codex with a ChatGPT Plus or Pro account',
        handler: async (invocation) => {
          try {
            await run(commandCtx.openaiCodex.login(
              createCommandInteraction(commandCtx, invocation, lifetime.signal),
            ))
            return { kind: 'success', text: 'Signed in to OpenAI Codex. Codex models are available in the model picker.' }
          } catch (error: unknown) {
            /* v8 ignore next -- command dispatch aborts the execute promise before this catch */
            if (invocation.signal.aborted) return { kind: 'error', text: 'Codex login cancelled.' }
            return { kind: 'error', text: errorText(error) }
          }
        },
      })
      yield commandCtx.commands.register({
        name: 'codex-logout',
        description: 'Remove the stored OpenAI Codex session',
        handler: async (invocation) => {
          if (invocation.rawInput.trim().length > 0) {
            return { kind: 'error', text: 'Usage: /codex-logout (no arguments)' }
          }
          try {
            await run(commandCtx.openaiCodex.logout())
            return { kind: 'success', text: 'Signed out of OpenAI Codex.' }
          } catch (error: unknown) {
            return { kind: 'error', text: errorText(error) }
          }
        },
      })
    }, 'llm-openai-codex commands')
  })

  installSettingsSection(ctx, NS, Config, config, {
    validate: (value) => {
      resolveAdapterOptions(value)
    },
    setSource: (source) => {
      current = source
    },
    onChange: syncRegistration,
  })

  ctx.effect(function* () {
    yield async () => {
      registrationClosed = true
      await registrationSync
    }
  }, 'llm-openai-codex registration synchronization')
}
