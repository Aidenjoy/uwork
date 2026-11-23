/** WorkBuddy-style profile, wallet balance, and subscription points summary pinned inside the signed-in account menu. */
import { Big } from 'big.js'
import type { MouseEvent } from 'react'
import {
  IconCheckOutlineRegular, IconCopyOutlineRegular, IconRefreshOutlineRegular, useClipboardCopy,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { AccountDetails, AccountLinks, AccountSubscription, AccountWallet } from '@deepseek-ai/dsh-deepseek-account/types'
import { AccountAvatar } from './AccountAvatar.tsx'
import type { AccountAvatarSnapshot } from './account-avatar.ts'
import { formatBalance, formatPoints } from './formatBalance.ts'
import type { AccountKey } from './locales.ts'
import type { PlatformPages } from './platform-pages.ts'
import css from './AccountMenuHeader.module.css'

/** Aggregated subscription summary rendered in the account menu and settings page. */
export type SubscriptionSummary =
  | { readonly kind: 'none' }
  | { readonly kind: 'unlimited'; readonly planTitle?: string }
  | { readonly kind: 'points'; readonly remaining: string; readonly total: string; readonly planTitle?: string }

/**
 * Aggregate active gateway subscriptions into one display summary.
 * @param subscriptions - active subscription records from the account balance response.
 * @returns aggregated unlimited state or summed remaining/total points.
 */
export function summarizeSubscriptions(subscriptions: readonly AccountSubscription[]): SubscriptionSummary {
  if (subscriptions.length === 0) return { kind: 'none' }
  const title = subscriptions.length === 1 ? subscriptions[0]?.planTitle : undefined
  if (subscriptions.some(sub => sub.unlimited)) {
    return title === undefined ? { kind: 'unlimited' } : { kind: 'unlimited', planTitle: title }
  }
  let remaining = new Big(0)
  let total = new Big(0)
  for (const sub of subscriptions) {
    remaining = remaining.plus(sub.remainingPoints)
    total = total.plus(sub.totalPoints)
  }
  return {
    kind: 'points',
    remaining: formatPoints(remaining.toString()),
    total: formatPoints(total.toString()),
    ...title === undefined ? {} : { planTitle: title },
  }
}

/** Props for the signed-in account menu summary header. */
export interface AccountMenuHeaderProps {
  details: Partial<AccountDetails> | undefined
  avatar: AccountAvatarSnapshot | undefined
  avatarFailed: (snapshot: AccountAvatarSnapshot) => void
  links: AccountLinks | undefined
  refreshing: boolean
  onRefresh: () => void
  onCloseMenu: () => void
  openPlatformPage?: PlatformPages['open'] | undefined
  t: (key: AccountKey) => string
}

function renderWallets(wallets: readonly AccountWallet[]) {
  return wallets.map(wallet => (
    <span key={wallet.currency}>{formatBalance(wallet.balance, wallet.currency === 'CNY' ? '¥' : '$')}</span>
  ))
}

/**
 * Render the profile card and wallet/subscription card pinned above the signed-in account menu items.
 * @param props - account details, avatar state, links, and refresh/navigation handlers.
 * @returns popover header card.
 */
export function AccountMenuHeader({
  details, avatar, avatarFailed, links, refreshing, onRefresh, onCloseMenu, openPlatformPage, t,
}: AccountMenuHeaderProps) {
  const profile = details?.profile?.status === 'ready' ? details.profile.value : undefined
  const displayName = profile?.name ?? profile?.username ?? profile?.contact ?? t('signedIn')
  const secondary = profile?.username && profile.username !== displayName ? profile.username : profile?.contact ?? null
  const copyText = profile?.username ?? profile?.name ?? profile?.id ?? ''
  const { copied, onCopy } = useClipboardCopy(copyText)

  const balance = details?.balance
  const gatewaySubscriptions = balance?.status === 'ready' ? balance.subscriptions : undefined
  const bonusWallets = balance?.status === 'ready' && gatewaySubscriptions === undefined
    ? balance.bonusWallets.filter(wallet => new Big(wallet.balance).gt(0)) : []
  const twoColumns = balance?.status === 'ready' && (gatewaySubscriptions !== undefined || bonusWallets.length > 0)
  const subSummary = gatewaySubscriptions === undefined ? undefined : summarizeSubscriptions(gatewaySubscriptions)
  const balanceLabelKey = balance?.status === 'ready' && gatewaySubscriptions === undefined ? 'balance' : 'walletBalance'

  const handlePlatformClick = (target: 'usage' | 'top-up') => (event: MouseEvent<HTMLAnchorElement>) => {
    if (openPlatformPage !== undefined) {
      event.preventDefault()
      onCloseMenu()
      openPlatformPage(target, () => undefined)
      return
    }
    onCloseMenu()
  }

  return (
    <div className={css.headerRoot}>
      <div className={css.profileCard}>
        <div className={css.identity}>
          <span className={css.avatar} data-avatar-status={avatar?.status}>
            <AccountAvatar avatar={avatar} avatarFailed={avatarFailed} />
          </span>
          <div className={css.identityCopy}>
            <span className={css.name}>{displayName}</span>
            {secondary !== null && <span className={css.handle}>{secondary}</span>}
          </div>
        </div>
        <div className={css.iconActions}>
          {copyText !== '' && (
            <button type="button" className={css.iconButton} aria-label={t(copied ? 'copiedAccount' : 'copyAccount')} onClick={onCopy}>
              {copied ? <IconCheckOutlineRegular size={14} /> : <IconCopyOutlineRegular size={14} />}
            </button>
          )}
          <button type="button" className={css.iconButton} aria-label={t('refreshBalance')} disabled={refreshing} onClick={onRefresh}>
            <IconRefreshOutlineRegular size={14} />
          </button>
        </div>
      </div>

      <div className={css.balanceCard}>
        <div className={css.metrics} data-columns={twoColumns ? '2' : '1'}>
          <div className={css.metric}>
            <span className={css.metricLabel}>{t(balanceLabelKey)}</span>
            {balance?.status === 'ready'
              ? balance.value.length > 0
                ? <span className={css.metricValue}>{renderWallets(balance.value)}</span>
                : <a className={css.unavailableLink} href={links?.usageUrl} target="_blank" rel="noreferrer"
                  onClick={handlePlatformClick('usage')}>{t('balanceUnavailable')}</a>
              : balance === undefined
                ? <span className={css.metricMuted}>{t('loading')}</span>
                : <a className={css.unavailableLink} href={links?.usageUrl} target="_blank" rel="noreferrer"
                  onClick={handlePlatformClick('usage')}>{t('balanceUnavailable')}</a>}
          </div>

          {subSummary !== undefined && (
            <div className={css.metric}>
              <span className={css.metricLabel}>{t('subscriptionPoints')}</span>
              {subSummary.kind === 'none' ? (
                <span className={css.metricMuted}>{t('noSubscription')}</span>
              ) : subSummary.kind === 'unlimited' ? (
                <>
                  <span className={css.metricValue}>{t('unlimited')}</span>
                  {subSummary.planTitle !== undefined && <span className={css.metricSub}>{subSummary.planTitle}</span>}
                </>
              ) : (
                <>
                  <span className={css.metricValue}>{subSummary.remaining}</span>
                  <span className={css.metricSub}>
                    {subSummary.planTitle !== undefined
                      ? `${subSummary.planTitle} · ${subSummary.remaining}/${subSummary.total}`
                      : `${subSummary.remaining} / ${subSummary.total}`}
                  </span>
                </>
              )}
            </div>
          )}

          {bonusWallets.length > 0 && (
            <div className={css.metric}>
              <span className={css.metricLabel}>{t('bonusBalance')}</span>
              <span className={css.metricValue}>{renderWallets(bonusWallets)}</span>
            </div>
          )}
        </div>

        <div className={css.ctaRow}>
          <a className={`${css.ctaButton} ${css.ctaPrimary}`} href={links?.topUpUrl} target="_blank" rel="noreferrer"
            onClick={handlePlatformClick('top-up')}>{t('topUp')}</a>
          <a className={css.ctaButton} href={links?.usageUrl} target="_blank" rel="noreferrer"
            onClick={handlePlatformClick('usage')}>{t('usage')}</a>
        </div>
      </div>
    </div>
  )
}
