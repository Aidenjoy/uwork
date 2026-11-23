/** Cloud conversation history viewer rendered inside AccountSection for utoken desktop accounts. */
import { useEffect, useState } from 'react'
import { IconRefreshOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  AccountConversationMessage, AccountConversationMessagesQuery, AccountConversationMessagesResult,
  AccountConversationsQuery, AccountConversationsResult, AccountConversationSummary,
} from '@deepseek-ai/dsh-deepseek-account/types'
import type { AccountKey } from './locales.ts'
import css from './AccountConversations.module.css'

const LIST_LIMIT = 30
const MESSAGES_LIMIT = 50

function formatIsoTime(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const pad = (v: number) => String(v).padStart(2, '0')
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function extractMessageText(payload: Record<string, unknown>): string {
  const versions = payload.versions
  if (Array.isArray(versions) && versions.length > 0) {
    const last: unknown = versions[versions.length - 1]
    if (typeof last === 'object' && last !== null && 'content' in last) {
      const content = (last as Record<string, unknown>).content
      if (typeof content === 'string') return content
    }
  }
  if (typeof payload.content === 'string') return payload.content
  return JSON.stringify(payload)
}

/** Props for the AccountSection cloud conversation history card. */
export interface AccountConversationsProps {
  loadConversations: (query: AccountConversationsQuery) => Promise<AccountConversationsResult | null>
  loadConversationMessages: (id: string, query: AccountConversationMessagesQuery) => Promise<AccountConversationMessagesResult | null>
  t: (key: AccountKey) => string
}

type ListState =
  | { readonly status: 'loading' }
  | { readonly status: 'hidden' }
  | { readonly status: 'failed' }
  | { readonly status: 'ready'; readonly items: readonly AccountConversationSummary[]; readonly hasMore: boolean }

type DetailState =
  | { readonly status: 'loading' }
  | { readonly status: 'failed' }
  | {
    readonly status: 'ready'
    readonly revision: number
    readonly items: readonly AccountConversationMessage[]
    readonly hasMore: boolean
  }

/**
 * Render the utoken cloud conversation history list and message viewer.
 * Hides itself when `loadConversations` returns `null`.
 * @param props - conversation list/message loaders and localized copy.
 * @returns conversation history card or `null` when unsupported.
 */
export function AccountConversations({ loadConversations, loadConversationMessages, t }: AccountConversationsProps) {
  const [refreshNonce, setRefreshNonce] = useState(0)
  const [listState, setListState] = useState<ListState>({ status: 'loading' })
  const [loadingMore, setLoadingMore] = useState(false)
  const [selected, setSelected] = useState<AccountConversationSummary | null>(null)
  const [detailState, setDetailState] = useState<DetailState>({ status: 'loading' })
  const [loadingEarlier, setLoadingEarlier] = useState(false)

  useEffect(() => {
    let cancelled = false
    setListState({ status: 'loading' })
    void loadConversations({ offset: 0, limit: LIST_LIMIT }).then((result) => {
      if (cancelled) return
      if (result === null) { setListState({ status: 'hidden' }); return }
      if (result.status === 'failed') { setListState({ status: 'failed' }); return }
      setListState({ status: 'ready', items: result.value.items, hasMore: result.value.hasMore })
    }, () => {
      if (!cancelled) setListState({ status: 'failed' })
    })
    return () => { cancelled = true }
  }, [loadConversations, refreshNonce])

  useEffect(() => {
    if (selected === null) return
    let cancelled = false
    setDetailState({ status: 'loading' })
    void loadConversationMessages(selected.id, { limit: MESSAGES_LIMIT }).then((result) => {
      if (cancelled) return
      if (result === null || result.status === 'failed') { setDetailState({ status: 'failed' }); return }
      setDetailState({
        status: 'ready',
        revision: result.value.revision,
        items: result.value.items,
        hasMore: result.value.hasMore,
      })
    }, () => {
      if (!cancelled) setDetailState({ status: 'failed' })
    })
    return () => { cancelled = true }
  }, [loadConversationMessages, selected])

  if (listState.status === 'hidden') return null

  const handleLoadMore = () => {
    if (listState.status !== 'ready' || loadingMore) return
    setLoadingMore(true)
    void loadConversations({ offset: listState.items.length, limit: LIST_LIMIT }).then((result) => {
      setLoadingMore(false)
      if (result?.status !== 'ready') return
      setListState({
        status: 'ready',
        items: [...listState.items, ...result.value.items],
        hasMore: result.value.hasMore,
      })
    }, () => { setLoadingMore(false) })
  }

  const handleLoadEarlier = () => {
    if (selected === null || detailState.status !== 'ready' || loadingEarlier || detailState.items.length === 0) return
    const first = detailState.items[0]
    if (first === undefined) return
    setLoadingEarlier(true)
    void loadConversationMessages(selected.id, {
      limit: MESSAGES_LIMIT, before: first.sequence, revision: detailState.revision,
    }).then((result) => {
      setLoadingEarlier(false)
      if (result?.status !== 'ready') return
      setDetailState({
        status: 'ready',
        revision: result.value.revision,
        items: [...result.value.items, ...detailState.items],
        hasMore: result.value.hasMore,
      })
    }, () => { setLoadingEarlier(false) })
  }

  return (
    <div className={css.card}>
      <div className={css.header}>
        <div className={css.headerLeft}>
          {selected !== null && (
            <button type="button" className={css.actionButton} onClick={() => { setSelected(null) }}>
              {t('conversationsBack')}
            </button>
          )}
          <span className={css.title}>
            {selected !== null ? (selected.title || t('conversationsUntitled')) : t('conversationsTitle')}
          </span>
        </div>
        {selected === null && (
          <button type="button" className={css.iconButton} aria-label={t('usageLogsRefresh')}
            disabled={listState.status === 'loading'} onClick={() => { setRefreshNonce(n => n + 1) }}>
            <IconRefreshOutlineRegular size={14} />
          </button>
        )}
      </div>

      {selected !== null ? (
        detailState.status === 'loading' ? (
          <div className={css.status}>{t('loading')}</div>
        ) : detailState.status === 'failed' ? (
          <div className={css.status}>
            <span>{t('conversationsFailed')}</span>
            <button type="button" className={css.actionButton} onClick={() => { setSelected({ ...selected }) }}>
              {t('platformRetry')}
            </button>
          </div>
        ) : detailState.items.length === 0 ? (
          <div className={css.status}>{t('conversationsNoMessages')}</div>
        ) : (
          <>
            {detailState.hasMore && (
              <div className={css.footer}>
                <button type="button" className={css.actionButton} disabled={loadingEarlier} onClick={handleLoadEarlier}>
                  {t('conversationsLoadEarlier')}
                </button>
              </div>
            )}
            <div className={css.messages}>
              {detailState.items.map(msg => (
                <div key={msg.id} className={css.message}>
                  <span className={css.messageRole}>
                    {msg.payload.from === 'user' ? t('conversationsUser') : t('conversationsAssistant')}
                  </span>
                  <span className={css.messageBody}>{extractMessageText(msg.payload)}</span>
                </div>
              ))}
            </div>
          </>
        )
      ) : listState.status === 'loading' ? (
        <div className={css.status}>{t('loading')}</div>
      ) : listState.status === 'failed' ? (
        <div className={css.status}>
          <span>{t('conversationsFailed')}</span>
          <button type="button" className={css.actionButton} onClick={() => { setRefreshNonce(n => n + 1) }}>
            {t('platformRetry')}
          </button>
        </div>
      ) : listState.items.length === 0 ? (
        <div className={css.status}>{t('conversationsEmpty')}</div>
      ) : (
        <>
          <div className={css.list}>
            {listState.items.map(item => (
              <button key={item.id} type="button" className={css.itemButton} onClick={() => { setSelected(item) }}>
                <span className={css.itemTitle}>{item.title || t('conversationsUntitled')}</span>
                <span className={css.itemTime}>{formatIsoTime(item.updateTime)}</span>
              </button>
            ))}
          </div>
          {listState.hasMore && (
            <div className={css.footer}>
              <button type="button" className={css.actionButton} disabled={loadingMore} onClick={handleLoadMore}>
                {t('conversationsLoadMore')}
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
