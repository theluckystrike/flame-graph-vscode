'use strict';
// A small Node.js program that builds an order report. samples/sample-app.cpuprofile was recorded from it with
// `node --cpu-prof samples/sample-app.js`. Open the profile and click a frame: this file opens at that function.
const crypto = require('crypto');

function makeOrders(count) {
  const orders = [];
  for (let i = 0; i < count; i++) {
    orders.push({
      id: `A-${100000 + i}`,
      email: `buyer${i % 977}@example.com`,
      items: Array.from({ length: 1 + (i % 7) }, (_, k) => ({ sku: `SKU-${(i * 31 + k) % 5000}`, qty: 1 + ((i + k) % 4), price: 3 + ((i * 7 + k * 13) % 200) / 4 })),
    });
  }
  return orders;
}

function roundTrip(orders) {
  return JSON.parse(JSON.stringify(orders));
}

const EMAIL = /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
function validate(orders) {
  return orders.filter((o) => EMAIL.test(o.email) && o.items.every((it) => it.qty > 0));
}

function orderTotal(order) {
  let sum = 0;
  for (const it of order.items) sum += it.qty * it.price;
  return Math.round(sum * 100) / 100;
}

function fingerprint(order) {
  return crypto.createHash('sha256').update(order.id + order.email).digest('hex').slice(0, 12);
}

function topCustomers(orders) {
  const by = new Map();
  for (const o of orders) by.set(o.email, (by.get(o.email) || 0) + orderTotal(o));
  return [...by.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
}

function toCsv(orders) {
  let out = 'id,email,total,fingerprint\n';
  for (const o of orders) out += `${o.id},${o.email},${orderTotal(o).toFixed(2)},${fingerprint(o)}\n`;
  return out;
}

function main() {
  let size = 0;
  for (let round = 0; round < 16; round++) {
    const orders = validate(roundTrip(makeOrders(20000)));
    const csv = toCsv(orders);
    size += csv.length + topCustomers(orders).length;
  }
  return size;
}

console.log(`report bytes: ${main()}`);
