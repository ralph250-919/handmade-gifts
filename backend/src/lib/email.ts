import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2';
import { formatMoney } from './orders.js';
import { tracer } from './observability.js';
import type { Order } from './types.js';

const ses = tracer.captureAWSv3Client(new SESv2Client({}));

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  const from = process.env.SENDER_EMAIL;
  if (!from) throw new Error('SENDER_EMAIL is not configured');
  await ses.send(
    new SendEmailCommand({
      FromEmailAddress: from,
      Destination: { ToAddresses: [msg.to] },
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: 'UTF-8' },
          Body: { Text: { Data: msg.text, Charset: 'UTF-8' }, Html: { Data: msg.html, Charset: 'UTF-8' } },
        },
      },
    }),
  );
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const shortId = (id: string) => id.slice(-8).toUpperCase();

function itemLines(order: Order): string[] {
  return order.items.map((i) => `${i.quantity} × ${i.name} — ${formatMoney(i.unitPriceCents * i.quantity, order.currency)}`);
}

export function orderConfirmationEmail(order: Order, shopName: string): EmailMessage {
  const lines = itemLines(order);
  const total = formatMoney(order.totalCents ?? order.subtotalCents, order.currency);
  return {
    to: order.customerEmail!,
    subject: `${shopName}: thank you for your order #${shortId(order.id)}`,
    text: [`Hi ${order.customerName ?? 'there'},`, '', `Thank you for your order! Each piece is made by hand, and we'll email you as soon as it ships.`, '', ...lines, '', `Total paid: ${total}`, '', `— ${shopName}`].join('\n'),
    html: `<p>Hi ${esc(order.customerName ?? 'there')},</p><p>Thank you for your order! Each piece is made by hand, and we'll email you as soon as it ships.</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p><strong>Total paid: ${esc(total)}</strong></p><p>— ${esc(shopName)}</p>`,
  };
}

export function newOrderOwnerEmail(order: Order, ownerEmail: string, siteUrl: string): EmailMessage {
  const lines = itemLines(order);
  const a = order.shippingAddress ?? {};
  const address = [a.name, a.line1, a.line2, [a.city, a.state, a.postalCode].filter(Boolean).join(' '), a.country].filter(Boolean);
  const total = formatMoney(order.totalCents ?? order.subtotalCents, order.currency);
  return {
    to: ownerEmail,
    subject: `New order #${shortId(order.id)} — ${total}`,
    text: [`New order from ${order.customerName ?? ''} <${order.customerEmail ?? ''}>`, '', ...lines, '', 'Ship to:', ...address, '', `Manage: ${siteUrl}/admin/`].join('\n'),
    html: `<p>New order from ${esc(order.customerName ?? '')} &lt;${esc(order.customerEmail ?? '')}&gt;</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul><p><strong>Ship to:</strong><br>${address.map((l) => esc(String(l))).join('<br>')}</p><p><a href="${esc(siteUrl)}/admin/">Open admin</a></p>`,
  };
}

export function shippedEmail(order: Order, shopName: string): EmailMessage {
  const tracking = order.trackingNumber ? `${order.carrier ? `${order.carrier} ` : ''}tracking number: ${order.trackingNumber}` : '';
  return {
    to: order.customerEmail!,
    subject: `${shopName}: your order #${shortId(order.id)} is on its way`,
    text: [`Hi ${order.customerName ?? 'there'},`, '', 'Good news — your order has shipped!', tracking, '', `— ${shopName}`].join('\n'),
    html: `<p>Hi ${esc(order.customerName ?? 'there')},</p><p>Good news — your order has shipped!</p>${tracking ? `<p>${esc(tracking)}</p>` : ''}<p>— ${esc(shopName)}</p>`,
  };
}
