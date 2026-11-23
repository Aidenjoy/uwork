/** Available onboarding credit includes both purchased and granted wallets. */
import { Big } from 'big.js'
import type { AccountSnapshot } from './AccountSection.tsx'

/**
 * Check purchased, granted, and active subscription credit without treating a pending query as zero.
 * @param balance - current account balance result.
 * @returns whether any wallet or active subscription has usable credit.
 */
export function hasOnboardingCredit(balance: NonNullable<AccountSnapshot['details']>['balance']): boolean {
  if (balance?.status !== 'ready') return false
  if ([...balance.value, ...balance.bonusWallets].some(wallet => new Big(wallet.balance).gt(0))) return true
  return balance.subscriptions?.some(sub => sub.unlimited || new Big(sub.remainingPoints).gt(0)) ?? false
}
