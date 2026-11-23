// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act, within } from '@testing-library/react'
import { useMemo, useSyncExternalStore } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { AccountDetails, AccountUserId, AccountView, SignInAttemptId } from '@deepseek-ai/dsh-deepseek-account/types'
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PlatformBridge } from '../src/client/PlatformOverlay.tsx'
import { createPlatformPages, type PlatformPages } from '../src/client/platform-pages.ts'
import { AccountPlatformHost } from '../src/client/AccountPlatformHost.tsx'
import { AccountSection, type AccountSectionInjected, type AccountSnapshot } from '../src/client/AccountSection.tsx'
import type { AccountMenuProps } from '../src/client/AccountMenu.tsx'
import type { AccountNotificationsOwnerProps } from '../src/client/account-ui.ts'
import type {} from '../src/client/index.ts'
import { en, zh, type AccountKey } from '../src/client/locales.ts'
import css from '../src/client/AccountSection.module.css'
import type { AccountAvatarSnapshot } from '../src/client/account-avatar.ts'
import { hasOnboardingCredit } from '../src/client/onboarding-balance.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

/** One resolved theme snapshot per scheme; the slot's theme hook serves these in the application. */
const themeOf = (colorScheme: 'light' | 'dark'): ThemeSnapshot => ({
  preference: colorScheme, fontSizes: { text: 14, code: 11, terminal: 13 }, fontFamilies: { text: '', code: '', terminal: '' },
  active: { id: colorScheme, colorScheme, tokens: {} }, themes: [], revision: 0,
})

function operationsOf(state: Omit<AccountView, 'links'>, details?: Partial<AccountDetails>, pages?: PlatformPages,
  avatar?: AccountAvatarSnapshot): AccountSectionInjected {
  return {
    ...pages === undefined ? {} : { openPlatformPage: pages.open },
    hooks: {
      account: {
        getSnapshot: () => ({ view: { ...state, links: { usageUrl: 'http://localhost:8081/usage', topUpUrl: 'http://localhost:8081/top_up' } }, details, avatar, failed: false }),
        subscribe: () => () => {},
      },
      theme: { getSnapshot: () => themeOf('light'), subscribe: () => () => {} },
    },
    hasRunningAccountTasks: vi.fn(async () => false),
    contactUs: vi.fn(), showLogin: vi.fn(), setOnboarding: vi.fn(),
    refreshAccount: vi.fn(() => Promise.resolve()),
    avatarFailed: vi.fn(),
    start: vi.fn(() => Promise.resolve()), cancel: vi.fn(() => Promise.resolve()), signOut: vi.fn(() => Promise.resolve()),
  }
}

function mount(state: Omit<AccountView, 'links'>, copy: typeof en | typeof zh = en, details?: Partial<AccountDetails>,
  platform?: PlatformBridge, avatar?: AccountAvatarSnapshot) {
  const pages = platform === undefined ? undefined : createPlatformPages()
  const operations = operationsOf(state, details, pages, avatar)
  // AccountSection consumes no global hooks; the slot supplies them in the application.
  const globals = {} as GlobalStandardProps
  render(<>
    <AccountSection {...globals} {...operations}
      useAccount={selector => selector(operations.hooks.account.getSnapshot())}
      useTheme={selector => selector(operations.hooks.theme.getSnapshot())}
      close={() => {}} t={key => key in copy ? copy[key as AccountKey] : key} />
    {/* The application renders this from `shell.overlay`; the settings page only requests a page. */}
    {platform !== undefined && pages !== undefined
      && <SharedPlatformHost Globals={globals} pages={pages} platform={platform} copy={copy}
        refreshAccount={operations.refreshAccount} />}
  </>)
  return operations
}

/** Test scaffold for the shell's host: real page subscription plus the opener's return read. */
function SharedPlatformHost({ Globals, pages, platform, copy, refreshAccount }: {
  Globals: GlobalStandardProps
  pages: PlatformPages
  platform: PlatformBridge
  copy: typeof en | typeof zh
  refreshAccount: () => Promise<void>
}) {
  const subscribe = useMemo(() => (listener: () => void) => pages.subscribe(listener), [pages])
  const usePage = useMemo(
    () => <T,>(selector: (claim: ReturnType<PlatformPages['getSnapshot']>) => T): T =>
      selector(useSyncExternalStore(subscribe, () => pages.getSnapshot())),
    [pages, subscribe],
  )
  return <AccountPlatformHost {...Globals} platform={platform} usePage={usePage}
    closePage={() => {
      // Scaffold-only emulation of the opener's return read; in the application
      // the injected opener owns it and this host only closes the page.
      const page = pages.getSnapshot()?.page
      pages.close()
      if (page === 'top-up') void refreshAccount()
    }} t={key => key in copy ? copy[key as AccountKey] : key} />
}

/**
 * @param operations - account face the launcher injects.
 * @param snapshot - reads the account state the launcher renders, so a rerender observes the latest value.
 * @param settingsOpen - whether the settings panel covers the sidebar.
 * @returns the sidebar launcher with its framework hooks wired to the test face.
 */
async function accountMenu(operations: AccountSectionInjected, snapshot: () => AccountSnapshot, settingsOpen: boolean,
  renderSlot: AccountMenuProps['renderSlot'] = () => null,
  openSettings: AccountMenuProps['openSettings'] = () => {}, wide = true) {
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  return <AccountMenu renderSlot={renderSlot} {...({} as GlobalStandardProps)} {...operations}
    settingsOpen={settingsOpen} useAccount={selector => selector(snapshot())} wide={wide}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())}
    openOnboarding={() => {}} openSettings={openSettings} t={key => en[key as AccountKey]} />
}

it.each([en, zh])('renders account cards without inventing profile or balance data', async (copy) => {
  mount({ status: 'credential-stored', attempt: null }, copy)
  expect(screen.getByText(copy.signedIn)).toBeTruthy()
  expect(screen.getAllByText(copy.loading)).toHaveLength(3)
  expect(screen.getByRole('link', { name: copy.usage }).getAttribute('href')).toBe('http://localhost:8081/usage')
  expect(screen.getByRole('link', { name: copy.topUp }).getAttribute('href')).toBe('http://localhost:8081/top_up')
  expect(screen.queryByRole('button', { name: copy.signOut })).toBeNull()
  expect(document.body.textContent).not.toContain('209.00')
  await expect(`${screen.getByRole('region').textContent}\n`).toMatchFileSnapshot(`./expected/account-${copy === en ? 'en' : 'zh'}.txt`)
})

it('starts sign-in and disables cancellation during persistence', async () => {
  const operations = mount({ status: 'signed-out', attempt: null })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signIn })) })
  expect(operations.start).toHaveBeenCalledOnce()
  cleanup()
  mount({ status: 'signed-out', attempt: { id: 'attempt' as SignInAttemptId, phase: 'committing' } })
  expect(screen.getByRole('button', { name: en.cancel }).hasAttribute('disabled')).toBe(true)
  expect(screen.queryByRole('button', { name: en.signIn })).toBeNull()
})

it.each([en, zh].flatMap(copy => ([false, true, 'unknown'] as const).map(running => ({ copy, running }))))('confirms sidebar sign-out with task impact $running', async ({ copy, running }) => {
  const signOut = vi.fn(() => Promise.resolve())
  const openSettings = vi.fn()
  const operations = mount({ status: 'credential-stored', attempt: null }, copy)
  cleanup()
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  render(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations} settingsOpen={false} signOut={signOut}
    hasRunningAccountTasks={async () => { if (running === 'unknown') throw new Error('offline'); return running }}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())} wide openOnboarding={() => {}} openSettings={openSettings}
    t={key => key in copy ? copy[key as AccountKey] : key} />)
  fireEvent.click(screen.getByRole('button', { name: copy.menu }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([copy.settings, copy.contactUs, copy.signOut])
  await expect(`${screen.getByRole('menu').textContent}\n`).toMatchFileSnapshot(`./expected/menu-${copy === en ? 'en' : 'zh'}.txt`)
  fireEvent.click(screen.getByRole('menuitem', { name: copy.settings }))
  expect(openSettings).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: copy.menu }))
  fireEvent.click(screen.getByRole('menuitem', { name: copy.contactUs }))
  expect(operations.contactUs).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: copy.menu }))
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: copy.signOut })) })
  expect(signOut).not.toHaveBeenCalled()
  expect(screen.getByText(running === 'unknown' ? copy.signOutUnknownDescription : running ? copy.signOutRunningDescription : copy.signOutDescription)).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.signOut })) })
  expect(signOut).toHaveBeenCalledOnce()
  expect(screen.queryByRole('menu')).toBeNull()
})

it.each([en, zh])('updates the Settings menu keycaps and accessible combination from its owner', async (copy) => {
  const operations = mount({ status: 'signed-out', attempt: null }, copy)
  cleanup()
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  const props: AccountMenuProps = { renderSlot: () => null,
    ...({} as GlobalStandardProps), ...operations, wide: true, settingsOpen: false,
    useAccount: selector => selector(operations.hooks.account.getSnapshot()),
    useTheme: selector => selector(operations.hooks.theme.getSnapshot()),
    openSettings: vi.fn(() => { expect(document.activeElement).toBe(screen.getByRole('button', { name: copy.menu })) }),
    openOnboarding: vi.fn(),
    t: key => key in copy ? copy[key as AccountKey] : key,
  }
  const view = render(<AccountMenu {...props} settingsShortcut={{ keys: ['⌘', ','], aria: 'Meta+,' }} />)
  fireEvent.click(screen.getByRole('button', { name: copy.menu }))
  const settings = screen.getByRole('menuitem', { name: copy.settings })
  expect(settings.getAttribute('aria-keyshortcuts')).toBe('Meta+,')
  expect([...settings.querySelectorAll('kbd')].map(key => key.textContent)).toEqual(['⌘', ','])

  view.rerender(<AccountMenu {...props} settingsShortcut={{ keys: ['Ctrl', 'Shift', 'S'], aria: 'Control+Shift+S' }} />)
  expect(settings.getAttribute('aria-keyshortcuts')).toBe('Control+Shift+S')
  expect([...settings.querySelectorAll('kbd')].map(key => key.textContent)).toEqual(['Ctrl', 'Shift', 'S'])

  view.rerender(<AccountMenu {...props} />)
  expect(settings.hasAttribute('aria-keyshortcuts')).toBe(false)
  expect(settings.querySelector('kbd')).toBeNull()
  fireEvent.click(settings)
  expect(props.openSettings).toHaveBeenCalledOnce()
})

it.each([en, zh])('offers settings, contact and sign-in from the signed-out account menu', async (copy) => {
  const openSettings = vi.fn()
  const operations = operationsOf({ status: 'signed-out', attempt: null })
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  render(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations} settingsOpen={false}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())} wide openOnboarding={() => {}} openSettings={openSettings}
    t={key => key in copy ? copy[key as AccountKey] : key} />)
  const trigger = screen.getByRole('button', { name: copy.menu })
  expect(trigger.textContent).toBe(copy.more)
  expect(trigger.querySelector('svg')).not.toBeNull()
  fireEvent.click(trigger)
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([copy.settings, copy.contactUs, copy.signIn])
  await expect(`${screen.getByRole('menu').textContent}\n`).toMatchFileSnapshot(`./expected/menu-signed-out-${copy === en ? 'en' : 'zh'}.txt`)
  fireEvent.click(screen.getByRole('menuitem', { name: copy.settings }))
  expect(openSettings).toHaveBeenCalledOnce()
  fireEvent.click(screen.getByRole('button', { name: copy.menu }))
  fireEvent.click(screen.getByRole('menuitem', { name: copy.contactUs }))
  expect(operations.contactUs).toHaveBeenCalledOnce()
})

it.each([true, false])('keeps the account inset local through sign-in changes with wide=%s', async (wide) => {
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  let operations = operationsOf({ status: 'signed-out', attempt: null })
  const props: AccountMenuProps = { renderSlot: () => null,
    ...({} as GlobalStandardProps), ...operations, wide, settingsOpen: false,
    useAccount: selector => selector(operations.hooks.account.getSnapshot()),
    useTheme: selector => selector(operations.hooks.theme.getSnapshot()),
    openSettings: vi.fn(), openOnboarding: vi.fn(), t: key => en[key as AccountKey],
  }
  const view = render(<AccountMenu {...props} />)
  const root = view.container.firstElementChild
  const trigger = screen.getByRole('button', { name: en.menu })
  trigger.focus()
  expect(root?.getAttribute('data-inset')).toBe('false')
  operations = operationsOf({ status: 'credential-stored', attempt: null })
  view.rerender(<AccountMenu {...props} />)
  expect(root?.getAttribute('data-inset')).toBe(String(wide))
  expect(screen.getByRole('button', { name: en.menu })).toBe(trigger)
  expect(document.activeElement).toBe(trigger)
  operations = operationsOf({ status: 'signed-out', attempt: null })
  view.rerender(<AccountMenu {...props} />)
  expect(root?.getAttribute('data-inset')).toBe('false')
})

it('reports a failed start in the login dialog, not as a sidebar alert', async () => {
  const operations = mount({ status: 'signed-out', attempt: null })
  cleanup()
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  const links = { usageUrl: 'http://localhost:8081/usage', topUpUrl: 'http://localhost:8081/top_up' }
  let snapshot: AccountSnapshot = { view: { status: 'signed-out', attempt: null, links }, details: undefined, avatar: undefined, failed: false }
  // The plugin's start publishes the failure through the account snapshot, then rejects.
  const start = vi.fn((): Promise<void> => {
    snapshot = { ...snapshot, loginVisible: true, loginFailed: true }
    return Promise.reject(new Error('account start failed'))
  })
  const view = render(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations} settingsOpen={false}
    start={start}
    useAccount={selector => selector(snapshot)} useTheme={selector => selector(operations.hooks.theme.getSnapshot())}
    wide openOnboarding={() => {}} openSettings={() => {}}
    t={key => key in en ? en[key as AccountKey] : key} />)
  fireEvent.click(screen.getByRole('button', { name: en.menu }))
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: en.signIn })) })
  expect(start).toHaveBeenCalledOnce()
  expect(screen.queryByRole('alert')).toBeNull()
  view.rerender(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations} settingsOpen={false}
    start={start}
    useAccount={selector => selector(snapshot)} useTheme={selector => selector(operations.hooks.theme.getSnapshot())}
    wide openOnboarding={() => {}} openSettings={() => {}}
    t={key => key in en ? en[key as AccountKey] : key} />)
  expect(screen.getByRole('dialog').textContent).toContain(en.failed)
  expect(screen.queryByRole('alert')).toBeNull()
  // The dialog is the only place that reports the failure, so its copy appears once.
  expect(document.body.textContent.split(en.failed)).toHaveLength(2)
  await expect(`${document.body.textContent}\n`).toMatchFileSnapshot('./expected/login-failed-en.txt')
})

it('keeps the confirmation dialog open after a failed sign-out', async () => {
  const operations = mount({ status: 'credential-stored', attempt: null })
  cleanup()
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  const signOut = vi.fn((): Promise<void> => Promise.reject(new Error('account sign-out failed')))
  render(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations} settingsOpen={false}
    signOut={signOut}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())} wide
    openOnboarding={() => {}} openSettings={() => {}} t={key => key in en ? en[key as AccountKey] : key} />)
  fireEvent.click(screen.getByRole('button', { name: en.menu }))
  await act(async () => { fireEvent.click(screen.getByRole('menuitem', { name: en.signOut })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signOut })) })
  // The confirmation dialog owns the failure; the launcher renders no error of its own.
  const dialog = screen.getByRole('dialog')
  expect(within(dialog).getByRole('alert').textContent).toBe(en.failed)
})

it.each([en, zh])('renders Platform profile and recharge wallet balances', async (copy) => {
  mount({ status: 'credential-stored', attempt: null }, copy, {
    profile: { status: 'ready', value: { id: null, name: 'Harness Mock (TEST ONLY)', contact: '138****0000' } },
    balance: { status: 'ready', bonusWallets: [], value: [{ currency: 'CNY', balance: '1234.56000000' }, { currency: 'USD', balance: '0.00000100' }] },
  })
  expect(screen.getByText('Harness Mock (TEST ONLY)')).toBeTruthy()
  expect(screen.getByText('138****0000')).toBeTruthy()
  expect(screen.getByText('¥1,234.56')).toBeTruthy()
  expect(screen.getByText('<$0.01')).toBeTruthy()
  await expect(`${screen.getByRole('region').textContent}\n`).toMatchFileSnapshot(`./expected/details-${copy === en ? 'en' : 'zh'}.txt`)
})

it.each([en, zh])('shows the signed-out settings prompt without balance or Platform links', async (copy) => {
  mount({ status: 'signed-out', attempt: null }, copy)
  expect(screen.getByText(copy.settingsSignedOutTitle)).toBeTruthy()
  expect(screen.getByText(copy.settingsSignedOutDescription)).toBeTruthy()
  expect(screen.queryByText(copy.balance)).toBeNull()
  expect(screen.queryByRole('link')).toBeNull()
  await expect(`${screen.getByRole('region').textContent}\n`)
    .toMatchFileSnapshot(`./expected/account-signed-out-${copy === en ? 'en' : 'zh'}.txt`)
})


it('opens usage inside Desktop and returns to the same Account settings', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const platform: PlatformBridge = { open: vi.fn(async () => {}), setBounds: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  mount({ status: 'credential-stored', attempt: null }, en, undefined, platform)
  const usage = screen.getByRole('link', { name: en.usage })
  act(() => { usage.focus() })
  await act(async () => { fireEvent.click(usage) })
  expect(platform.open).toHaveBeenCalledWith('usage', { x: 0, y: 0, width: 0, height: 0 })
  const back = screen.getByRole('button', { name: en.backToHarness })
  await expect(`${back.parentElement!.parentElement!.textContent}\n`).toMatchFileSnapshot('./expected/platform-header-en.txt')
  expect(screen.getByRole('dialog', { name: en.backToHarness }).dataset.shortcutModal).toBe('platform')
  await act(async () => { fireEvent.click(back) })
  expect(platform.close).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: en.backToHarness })).toBeNull()
  expect(screen.getByRole('region', { name: en.nav })).toBeTruthy()
  // The overlay's layout cleanup hands the page's return focus back to the link
  // that opened it, with no dialog to take it instead.
  expect(document.activeElement).toBe(usage)
})

it('keeps a return action available when the native document fails to load', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const platform: PlatformBridge = {
    open: vi.fn(async () => { throw new Error('load failed') }), setBounds: vi.fn(async () => {}), close: vi.fn(async () => {}),
  }
  mount({ status: 'credential-stored', attempt: null }, zh, undefined, platform)
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: zh.topUp })) })
  expect(platform.open).toHaveBeenCalledWith('top-up', { x: 0, y: 0, width: 0, height: 0 })
  expect(screen.getByText(zh.platformFailed)).toBeTruthy()
  const back = screen.getByRole('button', { name: zh.backToHarness })
  await expect(`${back.parentElement!.parentElement!.textContent}\n`).toMatchFileSnapshot('./expected/platform-header-zh.txt')
  await act(async () => { fireEvent.click(back) })
  expect(platform.close).toHaveBeenCalledOnce()
})

it.each([en, zh])('retries the failed Platform destination and removes the error after loading', async (copy) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const loaded = Promise.withResolvers<undefined>()
  const open = vi.fn<PlatformBridge['open']>()
    .mockRejectedValueOnce(new Error('load failed'))
    .mockRejectedValueOnce(new Error('still offline'))
    .mockReturnValueOnce(loaded.promise)
  const platform: PlatformBridge = { open, setBounds: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  mount({ status: 'credential-stored', attempt: null }, copy, undefined, platform)
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: copy.topUp })) })
  await expect(`${screen.getByRole('dialog').textContent}\n`)
    .toMatchFileSnapshot(`./expected/platform-error-${copy === en ? 'en' : 'zh'}.txt`)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.platformRetry })) })
  expect(screen.getByText(copy.platformFailed)).toBeTruthy()
  const retry = screen.getByRole('button', { name: copy.platformRetry })
  act(() => { retry.focus() })
  await act(async () => { fireEvent.click(retry) })
  expect(open.mock.calls.map(([page]) => page)).toEqual(['top-up', 'top-up', 'top-up'])
  expect(screen.queryByRole('button', { name: copy.platformRetry })).toBeNull()
  expect(screen.getByRole('status', { name: copy.loading })).toBeTruthy()
  // Retrying removes the button that was focused, so the return action keeps
  // keyboard focus instead of dropping it onto the document body.
  const backAgain = screen.getByRole('button', { name: copy.backToHarness })
  expect(document.activeElement).toBe(backAgain)
  await act(async () => { loaded.resolve(undefined); await loaded.promise })
  expect(screen.queryByText(copy.platformFailed)).toBeNull()
  expect(screen.queryByRole('status', { name: copy.loading })).toBeNull()
  expect(document.activeElement).toBe(backAgain)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: copy.backToHarness })) })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(platform.close).toHaveBeenCalledTimes(3)
})

it('ignores a retried document completing after returning to Account', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const loaded = Promise.withResolvers<undefined>()
  const open = vi.fn<PlatformBridge['open']>()
    .mockRejectedValueOnce(new Error('load failed')).mockReturnValueOnce(loaded.promise)
  const platform: PlatformBridge = { open, setBounds: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  mount({ status: 'credential-stored', attempt: null }, en, undefined, platform)
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: en.usage })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.platformRetry })) })
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.backToHarness })) })
  await act(async () => { loaded.resolve(undefined); await loaded.promise })
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(screen.getByRole('region', { name: en.nav })).toBeTruthy()
  expect(platform.close).toHaveBeenCalledTimes(2)
})

it('shows the profile while the balance is still loading', async () => {
  mount({ status: 'credential-stored', attempt: null }, en, {
    profile: { status: 'ready', value: { id: null, name: 'Ready User', contact: '138****0000' } },
  })
  expect(screen.getByText('Ready User')).toBeTruthy()
  // Both the recharge and the bonus row report their own pending read.
  expect(screen.getAllByText(en.loading)).toHaveLength(2)
  expect(screen.queryByText(en.balanceUnavailable)).toBeNull()
  await expect(`${screen.getByRole('region').textContent}\n`).toMatchFileSnapshot('./expected/profile-before-balance.txt')
})


it.each(['usage', 'top-up'] as const)('shows an accessible spinner until %s finishes loading', async (page) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const loaded = Promise.withResolvers<undefined>()
  const platform: PlatformBridge = { open: () => loaded.promise, setBounds: async () => {}, close: async () => {} }
  mount({ status: 'credential-stored', attempt: null }, en, undefined, platform)
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: page === 'usage' ? en.usage : en.topUp })) })
  const status = screen.getByRole('status', { name: en.loading })
  expect({ accessibleName: status.getAttribute('aria-label'), visibleText: status.textContent }).toMatchInlineSnapshot(`
    {
      "accessibleName": "Loading…",
      "visibleText": "",
    }
  `)
  expect(status.querySelector('[aria-hidden="true"]')).not.toBeNull()
  expect(screen.getByRole('button', { name: en.backToHarness })).toBeTruthy()
  await act(async () => { loaded.resolve(undefined) })
  expect(screen.queryByRole('status', { name: en.loading })).toBeNull()
})


it.each([
  ['Preferred name', '138****0000', 'Preferred name'],
  [null, '138****0000', '138****0000'],
  [null, 'u***@example.com', 'u***@example.com'],
  [null, null, en.signedIn],
])('uses the sidebar profile label %s / %s', async (name, contact, expected) => {
  const operations = mount({ status: 'credential-stored', attempt: null }, en, {
    profile: { status: 'ready', value: { id: null, name, contact } },
  })
  cleanup()
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  render(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations} settingsOpen={false}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())}
    wide openSettings={() => {}} openOnboarding={() => {}} t={key => en[key as AccountKey]} />)
  expect(screen.getByRole('button', { name: en.menu }).textContent).toBe(expected)
})

it('shows the same shared picture outcome in settings and the sidebar', async () => {
  const avatar: AccountAvatarSnapshot = { status: 'ready', url: 'https://example.test/avatar.png' }
  const operations = mount({ status: 'credential-stored', attempt: null }, en, {
    profile: { status: 'ready', value: { id: null, name: 'User', contact: null, avatarUrl: 'https://example.test/avatar.png' } },
  }, undefined, avatar)
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  render(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations} settingsOpen={false}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())}
    wide openSettings={() => {}} openOnboarding={() => {}} t={key => en[key as AccountKey]} />)
  const images = document.querySelectorAll('img')
  expect(images).toHaveLength(2)
  for (const image of images) expect(image.getAttribute('src')).toBe('https://example.test/avatar.png')
  for (const image of images) fireEvent.error(image)
  expect(operations.avatarFailed).toHaveBeenCalledTimes(2)
  expect(operations.avatarFailed).toHaveBeenCalledWith(avatar)
})

it.each(['loading', 'failed'] as const)('shows fallback until the shared avatar is ready (%s)', async (status) => {
  const { AccountAvatar } = await import('../src/client/AccountAvatar.tsx')
  const avatarFailed = vi.fn()
  const view = render(<AccountAvatar avatar={undefined} avatarFailed={avatarFailed} />)
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.querySelector('svg')).not.toBeNull()
  view.rerender(<AccountAvatar avatar={{ url: 'https://example.test/avatar.png', status }} avatarFailed={avatarFailed} />)
  expect(view.container.querySelector('img')).toBeNull()
  expect(view.container.querySelector('svg')).not.toBeNull()
  view.rerender(<AccountAvatar avatar={{ url: 'https://example.test/avatar.png', status: 'ready' }} avatarFailed={avatarFailed} />)
  expect(view.container.querySelector('img')!.getAttribute('src')).toBe('https://example.test/avatar.png')
  view.rerender(<AccountAvatar avatar={undefined} avatarFailed={avatarFailed} />)
  expect(view.container.querySelector('img')).toBeNull()
})

it.each([en, zh])('renders positive bonus wallets separately from recharge balances', async (copy) => {
  mount({ status: 'credential-stored', attempt: null }, copy, {
    balance: { status: 'ready', value: [{ currency: 'CNY', balance: '209.00' }, { currency: 'USD', balance: '20.07' }],
      bonusWallets: [{ currency: 'CNY', balance: '5.00' }, { currency: 'USD', balance: '0.000001' }] },
  })
  expect(screen.getByText(copy.balance).parentElement!.textContent).toBe(`${copy.balance}¥209.00$20.07`)
  expect(screen.getByText(copy.bonusBalance).parentElement!.textContent).toBe(`${copy.bonusBalance}¥5.00<$0.01`)
  expect(screen.getByRole('region').querySelectorAll(`.${css.divider}`)).toHaveLength(2)
  await expect(`${screen.getByRole('region').textContent}\n`)
    .toMatchFileSnapshot(`./expected/bonus-${copy === en ? 'en' : 'zh'}.txt`)
})

it.each([[], [{ currency: 'CNY' as const, balance: '0.00' }, { currency: 'USD' as const, balance: '-1.00' }]].map(bonusWallets => ({ bonusWallets })))(
  'omits the bonus row for zero or negative wallets', ({ bonusWallets }) => {
    mount({ status: 'credential-stored', attempt: null }, en, {
      balance: { status: 'ready', value: [{ currency: 'CNY', balance: '0' }], bonusWallets },
    })
    expect(screen.queryByText(en.bonusBalance)).toBeNull()
    // The divider above the bonus row goes with it.
    expect(screen.getByRole('region').querySelectorAll(`.${css.divider}`)).toHaveLength(1)
    expect(screen.getByText('¥0.00')).toBeTruthy()
    expect(screen.queryByText('¥-1.00')).toBeNull()
  },
)

it('opens more account information at the configured Platform origin without invoking the embedded bridge', () => {
  const platform: PlatformBridge = { open: vi.fn(), close: vi.fn(), setBounds: vi.fn() }
  mount({ status: 'credential-stored', attempt: null }, en, undefined, platform)
  const link = screen.getByRole('link', { name: en.accountInfo })
  expect(link.getAttribute('href')).toBe('http://localhost:8081/')
  expect(link.getAttribute('target')).toBe('_blank')
  expect(link.getAttribute('rel')).toBe('noopener noreferrer')
  fireEvent.click(link)
  expect(platform.open).not.toHaveBeenCalled()
})

it.each([en, zh])('shows a localized toast when the account credential expires', async (copy) => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const operations = mount({ status: 'signed-out', attempt: null }, copy)
  cleanup()
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  let expire: (() => void) | undefined
  const unsubscribe = vi.fn()
  const element = <AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations}
    settingsOpen={false} subscribeSessionExpired={(listener) => { expire = listener; return unsubscribe }}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())} wide openOnboarding={() => {}} openSettings={() => {}}
    t={key => key in copy ? copy[key as AccountKey] : key} />
  const view = render(element)
  expect(screen.queryByRole('alert')).toBeNull()
  act(() => { expire!() })
  expect(screen.getByRole('alert').textContent).toContain(copy.sessionExpired)
  await expect(`${screen.getByRole('alert').textContent}\n`).toMatchFileSnapshot(`./expected/expired-${copy === en ? 'en' : 'zh'}.txt`)
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(screen.queryByRole('alert')).toBeNull()
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
  render(element)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['initializing', 'waiting-browser', 'exchanging'] as const)('shows %s and lets the user cancel the active attempt', async (phase) => {
  const operations = mount({ status: 'signed-out', attempt: { id: 'attempt' as SignInAttemptId, phase, authorizeUrl: 'https://example.test/authorize' } })
  expect(screen.getByRole('link', { name: en.open }).getAttribute('href')).toBe('https://example.test/authorize?theme=light')
  expect(screen.getByRole('status').textContent).toBe(phase === 'initializing' ? en.initializing : phase === 'waiting-browser' ? en.waiting : en.completing)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.cancel })) })
  expect(operations.cancel).toHaveBeenCalledExactlyOnceWith('attempt')
})

it('opens the authorization link with the active application palette and follows later switches', () => {
  const authorizeUrl = 'https://platform.deepseek.com/dsh/authorize?state=example'
  const operations = operationsOf({ status: 'signed-out', attempt: { id: 'attempt' as SignInAttemptId, phase: 'waiting-browser', authorizeUrl } })
  const element = (theme: ThemeSnapshot) => <AccountSection {...({} as GlobalStandardProps)} {...operations}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(theme)} close={() => {}} t={key => key in en ? en[key as AccountKey] : key} />
  const view = render(element(themeOf('dark')))
  expect(screen.getByRole('link', { name: en.open }).getAttribute('href'))
    .toBe('https://platform.deepseek.com/dsh/authorize?state=example&theme=dark')
  view.rerender(element(themeOf('light')))
  expect(screen.getByRole('link', { name: en.open }).getAttribute('href'))
    .toBe('https://platform.deepseek.com/dsh/authorize?state=example&theme=light')
})

it.each(['failed', 'expired'] as const)('allows a new sign-in after the attempt is %s', (phase) => {
  mount({ status: 'signed-out', attempt: { id: 'attempt' as SignInAttemptId, phase } })
  expect(screen.getByRole('button', { name: en.signIn }).hasAttribute('disabled')).toBe(false)
})

it('shows unavailable details and keeps external Platform links usable in a browser', () => {
  mount({ status: 'credential-stored', attempt: null }, en, {
    profile: { status: 'failed' }, balance: { status: 'failed' },
  })
  expect(screen.getByText(en.profileUnavailable)).toBeTruthy()
  // The failed read keeps its copy in both balance rows, now as links into Platform.
  const unavailable = screen.getAllByRole('link', { name: en.balanceUnavailable })
  expect(unavailable).toHaveLength(2)
  for (const link of unavailable) expect(link.getAttribute('href')).toBe('http://localhost:8081/usage')
  for (const name of [en.usage, en.topUp, en.balanceUnavailable]) {
    const event = new MouseEvent('click', { bubbles: true, cancelable: true })
    screen.getAllByRole('link', { name })[0]!.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
  }
})

it('opens the embedded Platform page from a failed balance row on Desktop', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const platform: PlatformBridge = { open: vi.fn(async () => {}), setBounds: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  mount({ status: 'credential-stored', attempt: null }, en, { balance: { status: 'failed' } }, platform)
  // Both failed rows reach the same destination as the Usage action, so the user can
  // inspect the balance the Harness could not load without leaving the app.
  await act(async () => { fireEvent.click(screen.getAllByRole('link', { name: en.balanceUnavailable })[0]!) })
  expect(platform.open).toHaveBeenCalledWith('usage', expect.anything())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.backToHarness })) })
  expect(platform.close).toHaveBeenCalledOnce()
  expect(screen.queryByRole('button', { name: en.backToHarness })).toBeNull()
})

it('reports a rejected settings login and disables login while initial state is unavailable', async () => {
  const operations = mount({ status: 'signed-out', attempt: null })
  cleanup()
  let snapshot: AccountSnapshot = { view: undefined, details: undefined, avatar: undefined, failed: true }
  const props = { ...({} as GlobalStandardProps), ...operations,
    start: vi.fn(async () => { throw new Error('unavailable') }),
    useAccount: <T,>(select: (value: AccountSnapshot) => T) => select(snapshot),
    useTheme: <T,>(select: (value: ThemeSnapshot) => T) => select(operations.hooks.theme.getSnapshot()), close: () => {},
    t: (key: string) => en[key as AccountKey],
  }
  const view = render(<AccountSection {...props} />)
  expect(screen.getByRole('button', { name: en.signIn }).hasAttribute('disabled')).toBe(true)
  expect(screen.getByRole('status').textContent).toBe(en.failed)
  snapshot = operations.hooks.account.getSnapshot()
  view.rerender(<AccountSection {...props} />)
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.signIn })) })
  expect(screen.getByRole('status').textContent).toBe(en.failed)
})

it('dismisses a collapsed menu and hands its login dialog to the API-key onboarding step', async () => {
  const operations = mount({ status: 'credential-stored', attempt: null }, en, { profile: { status: 'failed' } })
  cleanup()
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  const openOnboarding = vi.fn()
  let snapshot = operations.hooks.account.getSnapshot()
  const props = { ...({} as GlobalStandardProps), ...operations, renderSlot: () => null, wide: false, settingsOpen: false,
    openSettings: vi.fn(), openOnboarding,
    useAccount: <T,>(select: (value: AccountSnapshot) => T) => select(snapshot),
    useTheme: <T,>(select: (value: ThemeSnapshot) => T) => select(operations.hooks.theme.getSnapshot()),
    t: (key: string) => en[key as AccountKey] }
  const view = render(<AccountMenu {...props} />)
  expect(screen.getByRole('button', { name: en.menu }).textContent).toBe('')
  fireEvent.click(screen.getByRole('button', { name: en.menu }))
  fireEvent.keyDown(document, { key: 'Escape' })
  expect(screen.queryByRole('menu')).toBeNull()
  snapshot = { ...snapshot, view: { ...snapshot.view!, status: 'signed-out' }, loginVisible: true }
  view.rerender(<AccountMenu {...props} />)
  fireEvent.click(screen.getByRole('button', { name: en.close }))
  expect(operations.showLogin).toHaveBeenLastCalledWith(false)
  fireEvent.click(screen.getByRole('button', { name: en.addApiKey }))
  expect(openOnboarding).toHaveBeenCalledExactlyOnceWith('deepseek-official')
  snapshot = { ...snapshot, onboarding: true }
  view.rerender(<AccountMenu {...props} />)
  expect(screen.queryByRole('dialog')).toBeNull()
})

it('reads once per Settings entry, whatever section the entry opens', async () => {
  const operations = mount({ status: 'credential-stored', attempt: null }, en)
  cleanup()
  let snapshot: AccountSnapshot = operations.hooks.account.getSnapshot()
  const view = render(await accountMenu(operations, () => snapshot, false))
  // The sidebar launcher outlives the panel, so a closed panel reads nothing.
  expect(operations.refreshAccount).not.toHaveBeenCalled()
  view.rerender(await accountMenu(operations, () => snapshot, true))
  expect(operations.refreshAccount).toHaveBeenCalledOnce()
  // Staying open — another section, a tab switch, or an unrelated re-render — is not a new entry.
  snapshot = { ...snapshot, details: { ...snapshot.details, balance: { status: 'ready', value: [], bonusWallets: [] } } }
  view.rerender(await accountMenu(operations, () => snapshot, true))
  view.rerender(await accountMenu(operations, () => snapshot, true))
  expect(operations.refreshAccount).toHaveBeenCalledOnce()
  // Closing and reopening is a new entry, so it reads again.
  view.rerender(await accountMenu(operations, () => snapshot, false))
  view.rerender(await accountMenu(operations, () => snapshot, true))
  expect(operations.refreshAccount).toHaveBeenCalledTimes(2)
})

it('reads the account again when the user returns from the top-up view, and not from usage', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  const platform: PlatformBridge = { open: vi.fn(async () => {}), setBounds: vi.fn(async () => {}), close: vi.fn(async () => {}) }
  const operations = mount({ status: 'credential-stored', attempt: null }, en, undefined, platform)
  // Opening the view enters the top-up page; leaving it is the user coming back to Settings.
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: en.topUp })) })
  expect(platform.open).toHaveBeenCalledWith('top-up', expect.anything())
  expect(operations.refreshAccount).not.toHaveBeenCalled()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.backToHarness })) })
  // The page leaves immediately and the account reads settle behind it.
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(operations.refreshAccount).toHaveBeenCalledOnce()
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: en.usage })) })
  expect(platform.open).toHaveBeenCalledWith('usage', expect.anything())
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.backToHarness })) })
  // Usage changed nothing the account owns, so returning from it reads nothing.
  expect(operations.refreshAccount).toHaveBeenCalledOnce()
})

it('reports resize failure, ignores late native failures, and tolerates a removed IPC receiver', async () => {
  let resize: (() => void) | undefined
  vi.stubGlobal('ResizeObserver', class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  const loaded = Promise.withResolvers<undefined>()
  const platform: PlatformBridge = { open: () => loaded.promise,
    setBounds: vi.fn(async () => { throw new Error('resize failed') }), close: vi.fn(async () => { throw new Error('window gone') }) }
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('tabindex', '0')
  document.body.append(svg)
  onTestFinished(() => { svg.remove() })
  svg.focus()
  mount({ status: 'credential-stored', attempt: null }, en, undefined, platform)
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: en.usage })) })
  await act(async () => { resize!() })
  expect(platform.setBounds).toHaveBeenCalled()
  expect(screen.getByText(en.platformFailed)).toBeTruthy()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.backToHarness })) })
  await act(async () => { loaded.reject(new Error('late failure')); await loaded.promise.catch(() => {}) })
  expect(screen.queryByRole('dialog')).toBeNull()
})

it.each([en, zh])('shows live model sign-in guidance without replaying it after remount', async (copy) => {
  vi.useFakeTimers()
  onTestFinished(() => { vi.useRealTimers() })
  const operations = operationsOf({ status: 'signed-out', attempt: null })
  let listener: (() => void) | undefined
  const unsubscribe = vi.fn(() => { listener = undefined })
  operations.subscribeModelSignInRequired = (next) => { listener = next; return unsubscribe }
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  const element = <AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations}
    settingsOpen={false}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())} wide openOnboarding={() => {}} openSettings={() => {}}
    t={key => key in copy ? copy[key as AccountKey] : key} />
  const view = render(element)
  expect(screen.queryByRole('alert')).toBeNull()
  act(() => { listener?.() })
  expect(screen.getByRole('alert').textContent).toBe(copy.modelSignInRequired)
  act(() => { listener?.() })
  expect(screen.getAllByRole('alert')).toHaveLength(1)
  await act(async () => { await vi.advanceTimersByTimeAsync(4000) })
  expect(screen.queryByRole('alert')).toBeNull()
  act(() => { listener?.() })
  expect(screen.getByRole('alert').textContent).toBe(copy.modelSignInRequired)
  view.unmount()
  expect(unsubscribe).toHaveBeenCalledOnce()
  render(element)
  expect(screen.queryByRole('alert')).toBeNull()
})

it.each(['desktopOnboardingVisible', 'onboarding'] as const)('hides the notification slot until %s ends', async (field) => {
  const operations = operationsOf({ status: 'credential-stored', attempt: null })
  let snapshot: AccountSnapshot = { ...operations.hooks.account.getSnapshot(), [field]: true }
  let active: boolean | undefined
  let openAccount: (() => void) | undefined
  const openSettings = vi.fn()
  const renderSlot: AccountMenuProps['renderSlot'] = (name, owner) => {
    expect(name).toBe('settings.launcher.notifications')
    const value: object = owner
    const props = value as AccountNotificationsOwnerProps
    active = props.active
    openAccount = props.openAccount
    return null
  }
  const view = render(await accountMenu(operations, () => snapshot, false, renderSlot, openSettings))
  expect(active).toBe(false)
  snapshot = { ...snapshot, [field]: false }
  view.rerender(await accountMenu(operations, () => snapshot, false, renderSlot, openSettings))
  expect(active).toBe(true)
  openAccount?.()
  expect(openSettings).toHaveBeenCalledExactlyOnceWith('account')
})

it('keeps notification DOM inside the launcher while the collapsed rail hides it', async () => {
  const operations = operationsOf({ status: 'credential-stored', attempt: null })
  const snapshot = () => operations.hooks.account.getSnapshot()
  const renderSlot: AccountMenuProps['renderSlot'] = () => <div role="status">Notification</div>
  const view = render(await accountMenu(operations, snapshot, false, renderSlot))
  const notice = screen.getByRole('status')
  expect(view.container.contains(notice)).toBe(true)
  view.rerender(await accountMenu(operations, snapshot, false, renderSlot, undefined, false))
  expect(screen.queryByRole('status')).toBeNull()
  expect(notice.isConnected).toBe(true)
  view.rerender(await accountMenu(operations, snapshot, false, renderSlot))
  expect(screen.getByRole('status')).toBe(notice)
})

it.each(['signed-out', 'credential-stored'] as const)('omits the Feedback menu item when contactUs is absent (%s)', async (status) => {
  const { contactUs: _contactUs, ...rest } = operationsOf({ status, attempt: null })
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  render(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...rest} settingsOpen={false}
    useAccount={selector => selector(rest.hooks.account.getSnapshot())}
    useTheme={selector => selector(rest.hooks.theme.getSnapshot())} wide openOnboarding={() => {}} openSettings={() => {}}
    t={key => key in zh ? zh[key as AccountKey] : key} />)
  fireEvent.click(screen.getByRole('button', { name: zh.menu }))
  expect(screen.getAllByRole('menuitem').map(item => item.textContent)).toEqual([
    zh.settings, status === 'credential-stored' ? zh.signOut : zh.signIn,
  ])
})

it.each([en, zh])('renders WorkBuddy-style profile, wallet balance, and subscription points in signed-in menu', async (copy) => {
  const details: Partial<AccountDetails> = {
    profile: { status: 'ready', value: { id: '329' as AccountUserId, name: 'Barua Sunwing', contact: null, username: 'barua' } },
    balance: {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '30' }],
      bonusWallets: [],
      subscriptions: [{
        subscriptionId: 8, planId: 1, planTitle: '体验版',
        totalPoints: '40', usedPoints: '1', remainingPoints: '39', unlimited: false, endTime: 1_798_000_000,
      }],
    },
  }
  const operations = operationsOf({ status: 'credential-stored', attempt: null }, details)
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  render(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...operations} settingsOpen={false}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())} wide openOnboarding={() => {}} openSettings={() => {}}
    t={key => key in copy ? copy[key as AccountKey] : key} />)
  fireEvent.click(screen.getByRole('button', { name: copy.menu }))
  const menu = screen.getByRole('menu')
  expect(within(menu).getByText('Barua Sunwing')).toBeTruthy()
  expect(within(menu).getByText('barua')).toBeTruthy()
  expect(within(menu).getByText(copy.walletBalance)).toBeTruthy()
  expect(within(menu).getByText('¥30.00')).toBeTruthy()
  expect(within(menu).getByText(copy.subscriptionPoints)).toBeTruthy()
  expect(within(menu).getByText('39')).toBeTruthy()
  expect(within(menu).getByText('体验版 · 39/40')).toBeTruthy()
  expect(within(menu).getByRole('link', { name: copy.topUp }).getAttribute('href')).toBe('http://localhost:8081/top_up')
  expect(within(menu).getByRole('link', { name: copy.usage }).getAttribute('href')).toBe('http://localhost:8081/usage')
})

it('shows empty, unlimited, and failed balance states in the signed-in popover header', async () => {
  const { AccountMenuHeader } = await import('../src/client/AccountMenuHeader.tsx')
  const links = { usageUrl: 'https://token.test/usage-logs', topUpUrl: 'https://token.test/wallet' }
  const common = { avatar: undefined, avatarFailed: vi.fn(), links, refreshing: false, onRefresh: vi.fn(), onCloseMenu: vi.fn() }
  const view = render(<AccountMenuHeader {...common}
    details={{ balance: { status: 'ready', value: [{ currency: 'CNY', balance: '1894.37' }], bonusWallets: [], subscriptions: [] } }}
    t={key => zh[key]} />)
  expect(screen.getByText('¥1,894.37')).toBeTruthy()
  expect(screen.getByText(zh.noSubscription)).toBeTruthy()
  view.rerender(<AccountMenuHeader {...common}
    details={{
      balance: {
        status: 'ready', value: [{ currency: 'CNY', balance: '0' }], bonusWallets: [],
        subscriptions: [{
          subscriptionId: 1, planId: 2, totalPoints: '0', usedPoints: '0', remainingPoints: '0', unlimited: true, endTime: 1_798_000_000,
        }],
      },
    }}
    t={key => zh[key]} />)
  expect(screen.getByText(zh.unlimited)).toBeTruthy()
  view.rerender(<AccountMenuHeader {...common} details={{ balance: { status: 'failed' } }} t={key => zh[key]} />)
  expect(screen.getByRole('link', { name: zh.balanceUnavailable }).getAttribute('href')).toBe('https://token.test/usage-logs')
})

it('refreshes on signed-in popover open and manual header click without refreshing signed-out menus', async () => {
  const signedOut = operationsOf({ status: 'signed-out', attempt: null })
  const { AccountMenu } = await import('../src/client/AccountMenu.tsx')
  const view = render(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...signedOut} settingsOpen={false}
    useAccount={selector => selector(signedOut.hooks.account.getSnapshot())}
    useTheme={selector => selector(signedOut.hooks.theme.getSnapshot())} wide openOnboarding={() => {}} openSettings={() => {}}
    t={key => key in en ? en[key as AccountKey] : key} />)
  fireEvent.click(screen.getByRole('button', { name: en.menu }))
  expect(signedOut.refreshAccount).not.toHaveBeenCalled()
  cleanup()

  const signedIn = operationsOf({ status: 'credential-stored', attempt: null })
  view.unmount()
  render(<AccountMenu renderSlot={() => null} {...({} as GlobalStandardProps)} {...signedIn} settingsOpen={false}
    useAccount={selector => selector(signedIn.hooks.account.getSnapshot())}
    useTheme={selector => selector(signedIn.hooks.theme.getSnapshot())} wide openOnboarding={() => {}} openSettings={() => {}}
    t={key => key in en ? en[key as AccountKey] : key} />)
  fireEvent.click(screen.getByRole('button', { name: en.menu }))
  expect(signedIn.refreshAccount).toHaveBeenCalledOnce()
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.refreshBalance })) })
  expect(signedIn.refreshAccount).toHaveBeenCalledTimes(2)
})

it('renders gateway subscription points in AccountSection when subscriptions are present', () => {
  mount({ status: 'credential-stored', attempt: null }, zh, {
    balance: {
      status: 'ready',
      value: [{ currency: 'CNY', balance: '30' }],
      bonusWallets: [],
      subscriptions: [{
        subscriptionId: 8, planId: 1, totalPoints: '40', usedPoints: '1', remainingPoints: '39', unlimited: false, endTime: 1_798_000_000,
      }],
    },
  })
  expect(screen.getByText('¥30.00')).toBeTruthy()
  expect(screen.getByText(zh.subscriptionPoints)).toBeTruthy()
  expect(screen.getByText('39 / 40')).toBeTruthy()
})

it('treats unlimited subscriptions as available onboarding credit even when remaining points are zero', () => {
  const zeroWallet = [{ currency: 'CNY' as const, balance: '0' }]
  const sub = {
    subscriptionId: 8, planId: 1, totalPoints: '40', usedPoints: '40',
    remainingPoints: '0', unlimited: true, endTime: 1_798_000_000,
  }
  expect(hasOnboardingCredit({ status: 'ready', value: zeroWallet, bonusWallets: [], subscriptions: [sub] })).toBe(true)
  expect(hasOnboardingCredit({
    status: 'ready', value: zeroWallet, bonusWallets: [], subscriptions: [{ ...sub, unlimited: false }],
  })).toBe(false)
  expect(hasOnboardingCredit({
    status: 'ready', value: zeroWallet, bonusWallets: [], subscriptions: [{ ...sub, unlimited: false, remainingPoints: '39' }],
  })).toBe(true)
})

it('renders desktop usage logs with pagination and hides when unsupported', async () => {
  const loadUsageLogs = vi.fn(async (query: { page?: number }) => ({
    status: 'ready' as const,
    value: {
      page: query.page ?? 1,
      pageSize: 5,
      total: 8,
      items: [{
        id: 4101,
        createdAt: 1_700_000_000,
        modelName: 'deepseek-v4-pro',
        type: query.page === 2 ? 5 : 2,
        promptTokens: 11,
        completionTokens: 7,
        quota: 0,
        subscriptionQuota: 9,
        tokenName: 'default',
        requestId: 'req-1',
        httpStatus: 200,
        useTime: 2,
        isStream: true,
        cacheHit: false,
        taskSettle: false,
        userInput: '请帮我分析这段代码',
        userInputTruncated: false,
        consumption: {
          walletAmount: 0, walletUnit: 'USD', walletSymbol: '$', subscriptionPoints: 1.5, subscriptionUnit: 'points',
        },
      }],
    },
  }))
  const operations = { ...operationsOf({ status: 'credential-stored', attempt: null }), loadUsageLogs }
  const view = render(<AccountSection {...({} as GlobalStandardProps)} {...operations} close={() => {}}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())}
    t={key => key in zh ? zh[key as AccountKey] : key} />)

  expect(await screen.findByText('deepseek-v4-pro')).toBeTruthy()
  expect(screen.getByText('请帮我分析这段代码')).toBeTruthy()
  expect(screen.getByText('1.5 点数')).toBeTruthy()
  expect(screen.getByText('1 / 2')).toBeTruthy()

  fireEvent.click(screen.getByRole('button', { name: zh.usageLogsNext }))
  await vi.waitFor(() => { expect(loadUsageLogs).toHaveBeenCalledWith({ page: 2, pageSize: 5 }) })
  expect(await screen.findByText(zh.usageLogsErrorTag)).toBeTruthy()

  const hiddenLoader = vi.fn(async () => null)
  const hiddenOps = { ...operationsOf({ status: 'credential-stored', attempt: null }), loadUsageLogs: hiddenLoader }
  view.rerender(<AccountSection {...({} as GlobalStandardProps)} {...hiddenOps} close={() => {}}
    useAccount={selector => selector(hiddenOps.hooks.account.getSnapshot())}
    useTheme={selector => selector(hiddenOps.hooks.theme.getSnapshot())}
    t={key => key in zh ? zh[key as AccountKey] : key} />)
  await vi.waitFor(() => { expect(screen.queryByText(zh.usageLogsTitle)).toBeNull() })
})

it('renders cloud conversation history list, message detail, and earlier pagination', async () => {
  const loadConversations = vi.fn(async () => ({
    status: 'ready' as const,
    value: {
      items: [{
        id: 'conv-1',
        title: '测试会话',
        revision: 3,
        createTime: '2026-11-23T08:00:00Z',
        updateTime: '2026-11-23T08:05:00Z',
      }],
      hasMore: false,
    },
  }))
  const loadConversationMessages = vi.fn(async (_id: string, query: { before?: number; revision?: number }) => ({
    status: 'ready' as const,
    value: query.before === 51 ? {
      revision: 3,
      items: [{
        id: 'msg-0',
        sequence: 50,
        payload: { key: 'msg-0', from: 'user', versions: [{ id: 'v0', content: '更早的问题' }] },
      }],
      hasMore: false,
    } : {
      revision: 3,
      items: [{
        id: 'msg-1',
        sequence: 51,
        payload: { key: 'msg-1', from: 'assistant', versions: [{ id: 'v1', content: '你好，有什么可以帮助你的？' }] },
      }],
      hasMore: true,
    },
  }))
  const operations = { ...operationsOf({ status: 'credential-stored', attempt: null }), loadConversations, loadConversationMessages }
  render(<AccountSection {...({} as GlobalStandardProps)} {...operations} close={() => {}}
    useAccount={selector => selector(operations.hooks.account.getSnapshot())}
    useTheme={selector => selector(operations.hooks.theme.getSnapshot())}
    t={key => key in zh ? zh[key as AccountKey] : key} />)

  const convBtn = await screen.findByRole('button', { name: /测试会话/ })
  fireEvent.click(convBtn)
  expect(await screen.findByText('你好，有什么可以帮助你的？')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: zh.conversationsLoadEarlier }))
  await vi.waitFor(() => {
    expect(loadConversationMessages).toHaveBeenCalledWith('conv-1', { limit: 50, before: 51, revision: 3 })
  })
  expect(await screen.findByText('更早的问题')).toBeTruthy()
})
