/** Paginated model usage logs card rendered inside AccountSection for utoken desktop accounts. */
import { useEffect, useState } from 'react'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AccountUsageLogItem, AccountUsageLogsPage, AccountUsageLogsQuery, AccountUsageLogsResult,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountKey } from './locales.ts'
import css from './AccountUsageLogs.module.css'

const PAGE_SIZE = 20
const MAX_OFFSET = 9_999

function formatInt(value: number): string {
  return new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 }).format(value)
}

function formatTimestamp(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000)
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

function formatUsageQuota(item: AccountUsageLogItem): string {
  if (item.subscriptionQuota > 0 && item.quota > 0) return `${formatInt(item.subscriptionQuota)} + ${formatInt(item.quota)}`
  if (item.subscriptionQuota > 0) return formatInt(item.subscriptionQuota)
  if (item.quota > 0) return formatInt(item.quota)
  return '0'
}

function formatDuration(seconds: number): string {
  return `${seconds}s`
}

/** Props for the AccountSection usage logs card. */
export interface AccountUsageLogsProps {
  loadUsageLogs: (query: AccountUsageLogsQuery) => Promise<AccountUsageLogsResult | null>
  t: (key: AccountKey) => string
}

type LogsState =
  | { readonly status: 'loading' }
  | { readonly status: 'hidden' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly data: AccountUsageLogsPage }

/**
 * Render the WorkBuddy-style usage logs table card for utoken desktop accounts.
 * Hides itself when `loadUsageLogs` returns `null` (for example on Platform deployments).
 * @param props - usage logs loader and localized copy.
 * @returns usage logs card or `null` when unsupported.
 */
export function AccountUsageLogs({ loadUsageLogs, t }: AccountUsageLogsProps) {
  const [page, setPage] = useState(1)
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [state, setState] = useState<LogsState>({ status: 'loading' })

  useEffect(() => {
    let cancelled = false
    setState({ status: 'loading' })
    void loadUsageLogs({ page, pageSize: PAGE_SIZE }).then((result) => {
      if (cancelled) return
      if (result === null) { setState({ status: 'hidden' }); return }
      if (result.status === 'failed') { setState({ status: 'failed' }); return }
      setState({ status: 'ready', data: result.value })
    }, () => {
      if (!cancelled) setState({ status: 'failed' })
    })
    return () => { cancelled = true }
  }, [loadUsageLogs, page, refreshNonce])

  if (state.status === 'hidden') return null

  const maxPage = state.status === 'ready'
    ? Math.max(1, Math.min(Math.ceil(state.data.total / state.data.pageSize), Math.floor(MAX_OFFSET / state.data.pageSize) + 1))
    : 1

  return (
    <div className={css.card}>
      <div className={css.header}>
        <span className={css.title}>{t('usageLogsTitle')}</span>
        <button type="button" className={css.iconButton} aria-label={t('usageLogsRefresh')}
          disabled={state.status === 'loading'} onClick={() => { setRefreshNonce(n => n + 1) }}>
          <IconRefreshOutlineRegular size={14} />
        </button>
      </div>

      {state.status === 'loading' ? (
        <div className={css.status}>{t('loading')}</div>
      ) : state.status === 'failed' ? (
        <div className={css.status}>
          <span>{t('usageLogsFailed')}</span>
          <button type="button" className={css.pageButton} onClick={() => { setRefreshNonce(n => n + 1) }}>
            {t('platformRetry')}
          </button>
        </div>
      ) : state.data.items.length === 0 ? (
        <div className={css.status}>{t('usageLogsEmpty')}</div>
      ) : (
        <>
          <div className={css.tableHeader}>
            <span>{t('usageLogsColRequest')}</span>
            <span>{t('usageLogsColUsage')}</span>
            <span>{t('usageLogsColModel')}</span>
          </div>
          <div className={css.rows}>
            {state.data.items.map(item => (
              <div key={item.id} className={css.row}>
                <div className={css.requestCol}>
                  <div className={css.requestMain}>
                    <span>{`${formatInt(item.promptTokens)} + ${formatInt(item.completionTokens)} ${t('usageLogsTokens')}`}</span>
                    {item.useTime > 0 && <span className={css.requestMeta}>{formatDuration(item.useTime)}</span>}
                    {item.type === 5 && <span className={css.errorTag}>{t('usageLogsErrorTag')}</span>}
                  </div>
                  <span className={css.requestMeta}>{formatTimestamp(item.createdAt)}</span>
                </div>
                <span className={css.usageCol}>{formatUsageQuota(item)}</span>
                <span className={css.modelCol} title={item.modelName}>{item.modelName}</span>
              </div>
            ))}
          </div>
          {state.data.total > state.data.pageSize && (
            <div className={css.pagination}>
              <button type="button" className={css.pageButton} disabled={page <= 1}
                onClick={() => { setPage(p => Math.max(1, p - 1)) }}>{t('usageLogsPrev')}</button>
              <span className={css.pageInfo}>{`${state.data.page} / ${maxPage}`}</span>
              <button type="button" className={css.pageButton} disabled={page >= maxPage}
                onClick={() => { setPage(p => Math.min(maxPage, p + 1)) }}>{t('usageLogsNext')}</button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
