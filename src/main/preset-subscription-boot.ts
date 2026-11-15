/** Offer the preset subscription inside a managed CLI child, before DSH reads its profile. */
import { initWebProfile, installationProvides } from './profile-boot.ts'
import { offerPresetSubscription, PLUGIN_MARKET_BUNDLE } from './preset-subscription.ts'

export const PRESET_SUBSCRIPTION_VARIABLE = 'DSH_DESKTOP_PRESET_SUBSCRIPTION'

export interface PresetSubscriptionRequest {
  home: string
}

export async function preparePresetSubscription(entry: string, request: PresetSubscriptionRequest): Promise<void> {
  try {
    // A first-ever home has no profile until this call, which is what lets the
    // very first launch already open with the subscription.
    const anchor = await initWebProfile(entry, request.home)
    const outcome = offerPresetSubscription(request.home, installationProvides(anchor, PLUGIN_MARKET_BUNDLE))
    console.log('[desktop] preset plugin index: ' + outcome)
  } catch (error) {
    // An offer that cannot be made is never a reason to stop the runtime.
    console.warn('[desktop] preset plugin index not offered: ' + (error instanceof Error ? error.message : String(error)))
  }
}
