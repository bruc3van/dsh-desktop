/**
 * The identity sources this deployment has: the sign-in connectors, and the
 * directory connector when an upstream directory is configured.
 * @module @dsh-desktop-pro/server/identity
 */

import type { ServerConfig } from '../config.ts'
import { createDingTalk } from './dingtalk.ts'
import { createFeishu } from './feishu.ts'
import { createOidc } from './oidc.ts'
import type { DirectoryConnector, SignInConnector } from './types.ts'
import { createWeCom } from './wecom.ts'

export function createIdentitySources(config: ServerConfig, fetchImpl: typeof fetch = fetch): { signIn: SignInConnector[]; directory?: DirectoryConnector } {
  const signIn: SignInConnector[] = []
  let directory: DirectoryConnector | undefined
  if (config.directory !== undefined) {
    const source = config.directory.kind === 'feishu' ? createFeishu(config.directory.feishu, fetchImpl)
      : config.directory.kind === 'dingtalk' ? createDingTalk(config.directory.dingtalk, fetchImpl)
        : createWeCom(config.directory.wecom, fetchImpl)
    signIn.push(source.signIn)
    directory = source.directory
  }
  if (config.oidc !== undefined) signIn.push(createOidc(config.oidc, fetchImpl))
  return { signIn, ...directory !== undefined && { directory } }
}
