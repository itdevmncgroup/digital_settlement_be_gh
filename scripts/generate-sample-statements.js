// Generates 5 sample bank/credit-card settlement PDFs, 10 transaction lines
// each (8 credit-card purchases + 2 non-card items: fees/transfers), then
// uploads each straight through POST /bank-settlements (as ADMIN) so the
// mobile app's Settlement tab has real demo data to browse immediately.
//
// Usage: node scripts/generate-sample-statements.js
// Requires the backend running locally (npm run start:dev) and pdf-lib
// installed (devDependency).

const fs = require('fs');
const path = require('path');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { PrismaClient } = require('@prisma/client');

const API_URL = process.env.API_URL || 'http://localhost:3000/api/v1';
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@example.com';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Admin@12345';
const OUT_DIR = path.join(__dirname, '..', 'sample-data', 'bank-statements');

const prisma = new PrismaClient();

const CARD_MERCHANTS = [
  'STARBUCKS COFFEE SENAYAN CITY',
  'GRAB* A-9F2P9HUGXFBRAV JAKARTA',
  'PLAZA INDONESIA F&B JAKARTA',
  "MCDONALD'S SUDIRMAN JAKARTA",
  'HOTEL MULIA SENAYAN JAKARTA',
  'GARUDA INDONESIA JAKARTA',
  'KOPI KENANGAN KUNINGAN',
  'PT ANEKA CATERING JAKARTA',
  'SUSHI TEI PLAZA SENAYAN',
  'THE RITZ CARLTON JAKARTA',
  'AEON MALL BSD TANGERANG',
  'BLUE BIRD TAXI JAKARTA',
];

const OTHER_MERCHANTS = [
  { desc: 'BIAYA ADMIN BULANAN KARTU KREDIT', amountRange: [10000, 25000] },
  { desc: 'TRANSFER ANTAR BANK VIA LLG', amountRange: [50000, 150000] },
  { desc: 'GOPAYID TOP UP DKI JAKARTA', amountRange: [100000, 500000] },
  { desc: 'OVO TOP UP JAKARTA SELATAN', amountRange: [100000, 500000] },
  { desc: 'BIAYA MATERAI E-STATEMENT', amountRange: [10000, 10000] },
];

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[randInt(0, arr.length - 1)];
}

function formatDdMmYyyy(date) {
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

function formatAmount(n) {
  return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/**
 * Builds 10 transaction lines: 8 credit-card purchases (real amount reused
 * from an existing Expense every 3rd line so the auto-matcher has genuine
 * candidates to suggest) + 2 non-card items, in the same
 * "DD/MM/YYYY DD/MM/YYYY DESCRIPTION AMOUNT[ CR]" shape the parser expects.
 */
function buildLines(cardLast4, realExpenses) {
  const lines = [];
  const today = new Date();

  for (let i = 0; i < 8; i++) {
    const txnDate = addDays(today, -randInt(1, 45));
    const postDate = addDays(txnDate, randInt(0, 2));
    const useReal = realExpenses.length > 0 && i % 3 === 0;
    const realExpense = useReal ? realExpenses.shift() : null;
    const amount = realExpense ? Number(realExpense.amount) : randInt(80, 3000) * 1000;
    const merchant = pick(CARD_MERCHANTS);
    lines.push(`${formatDdMmYyyy(txnDate)}  ${formatDdMmYyyy(postDate)}  ${merchant} **** ${cardLast4}  ${formatAmount(amount)}`);
  }

  for (let i = 0; i < 2; i++) {
    const txnDate = addDays(today, -randInt(1, 45));
    const postDate = addDays(txnDate, randInt(0, 1));
    const other = pick(OTHER_MERCHANTS);
    const amount = randInt(other.amountRange[0], other.amountRange[1]);
    lines.push(`${formatDdMmYyyy(txnDate)}  ${formatDdMmYyyy(postDate)}  ${other.desc}  ${formatAmount(amount)} CR`);
  }

  // Shuffle so card/non-card lines aren't grouped predictably, then sort by date like a real statement.
  return lines;
}

async function buildPdf(title, cardLast4, lines) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = 800;
  page.drawText('MNC BANK — Rekening Tagihan Kartu Kredit (SAMPLE DATA)', { x: 40, y, size: 13, font: bold });
  y -= 20;
  page.drawText(title, { x: 40, y, size: 10, font, color: rgb(0.4, 0.4, 0.4) });
  y -= 16;
  page.drawText(`Nomor Kartu: 4267-5000-0047-${cardLast4}`, { x: 40, y, size: 10, font });
  y -= 30;

  page.drawText('Tanggal Transaksi   Tanggal Pembukuan   Perincian Transaksi', { x: 40, y, size: 9, font: bold });
  page.drawText('Jumlah (Rp)', { x: 460, y, size: 9, font: bold });
  y -= 8;
  page.drawLine({ start: { x: 40, y }, end: { x: 555, y }, thickness: 0.5, color: rgb(0.7, 0.7, 0.7) });
  y -= 16;

  for (const line of lines) {
    page.drawText(line, { x: 40, y, size: 9, font });
    y -= 18;
  }

  return doc.save();
}

async function login() {
  const res = await fetch(`${API_URL}/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
  });
  if (!res.ok) throw new Error(`Login failed: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.accessToken;
}

async function uploadStatement(token, filePath) {
  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'application/pdf' }), path.basename(filePath));
  const res = await fetch(`${API_URL}/bank-settlements`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: form,
  });
  if (!res.ok) throw new Error(`Upload failed for ${filePath}: ${res.status} ${await res.text()}`);
  return res.json();
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const expenses = await prisma.expense.findMany({
    where: { settlementId: null, bankTransactions: { none: {} } },
    select: { id: true, amount: true },
    take: 20,
  });
  console.log(`Found ${expenses.length} unmatched Expense(s) to seed realistic amounts from.`);

  const cardLast4Pool = ['0001', '0002', '4113', '7788', '2299'];
  const generated = [];

  for (let i = 1; i <= 5; i++) {
    const cardLast4 = cardLast4Pool[(i - 1) % cardLast4Pool.length];
    // Give each statement a slice of the pooled real expenses so amounts aren't reused across files.
    const slice = expenses.splice(0, 3);
    const lines = buildLines(cardLast4, slice);
    const title = `Statement ${i} of 5 — Card •••• ${cardLast4} — generated ${new Date().toISOString().slice(0, 10)}`;
    const pdfBytes = await buildPdf(title, cardLast4, lines);
    const fileName = `sample-statement-${i}.pdf`;
    const filePath = path.join(OUT_DIR, fileName);
    fs.writeFileSync(filePath, pdfBytes);
    generated.push(filePath);
    console.log(`Wrote ${filePath} (10 lines: 8 card + 2 other)`);
  }

  console.log('\nUploading via POST /bank-settlements as', ADMIN_EMAIL, '...');
  let token;
  try {
    token = await login();
  } catch (err) {
    console.error('Could not log in to upload automatically:', err.message);
    console.error('PDFs were still generated in', OUT_DIR, '- upload them manually via web-admin > Auto Matching, or the mobile app.');
    return;
  }

  for (const filePath of generated) {
    try {
      const batch = await uploadStatement(token, filePath);
      console.log(`Uploaded ${path.basename(filePath)} -> batch ${batch.id} (${batch.transactions?.length ?? '?'} lines parsed)`);
    } catch (err) {
      console.error(`Failed to upload ${filePath}:`, err.message);
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
