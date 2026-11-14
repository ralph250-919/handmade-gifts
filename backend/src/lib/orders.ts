import type { OrderStatus } from './types.js';

/**
 * Every order state change the shop makes. Code that moves an order passes one
 * of these to `transitionOrder`, so this table is the single source of truth.
 */
export const Transitions = {
  pay: { from: ['PENDING'], to: 'PAID' },
  expire: { from: ['PENDING'], to: 'EXPIRED' },
  failPayment: { from: ['PENDING'], to: 'CANCELLED' },
  ship: { from: ['PAID'], to: 'SHIPPED' },
} as const satisfies Record<string, { from: readonly OrderStatus[]; to: OrderStatus }>;

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return Object.values(Transitions).some((t) => t.to === to && (t.from as readonly OrderStatus[]).includes(from));
}

export function formatMoney(cents: number, currency: string): string {
  return new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(cents / 100);
}
