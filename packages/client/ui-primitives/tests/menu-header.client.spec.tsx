// @vitest-environment jsdom
/** Menu header pinning and keyboard-walk isolation from header buttons. */
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Menu } from '../src/Menu.tsx'

afterEach(cleanup)

it('pins the header above items and scopes autoFocus and arrow keys to menuitem rows', () => {
  const onAction = vi.fn()
  const onHeaderClick = vi.fn()
  render(<Menu open portal autoFocus
    anchor={<button type="button">Account menu</button>}
    header={<div><button type="button" onClick={onHeaderClick}>Copy handle</button></div>}
    items={[
      { id: 'settings', label: 'Settings' },
      { id: 'signout', label: 'Sign out' },
    ]}
    onSelect={onAction}
    onClose={() => undefined} />)

  const headerButton = screen.getByRole('button', { name: 'Copy handle' })
  const settings = screen.getByRole('menuitem', { name: 'Settings' })
  const signout = screen.getByRole('menuitem', { name: 'Sign out' })
  expect(document.activeElement).toBe(settings)
  expect(headerButton.compareDocumentPosition(settings) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

  fireEvent.keyDown(document, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(signout)
  fireEvent.keyDown(document, { key: 'ArrowDown' })
  expect(document.activeElement).toBe(settings)

  fireEvent.click(headerButton)
  expect(onHeaderClick).toHaveBeenCalledOnce()
  expect(onAction).not.toHaveBeenCalled()
})
