import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../src/i18n.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source + '\nexport { STRINGS };', {
 compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText;
const { setLanguage, getCurrentLanguage, t, STRINGS } = await import(`data:text/javascript;base64,${Buffer.from(js).toString('base64')}`);
const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
try {
 for (const [locale, expected] of [['ru','ru'],['ru-RU','ru'],['RU_ru','ru'],['en-US','en'],['de-DE','en'],['','en'],['russian','en']]) {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: {language: locale} });
  setLanguage('auto');
  assert.equal(getCurrentLanguage(), expected, locale);
  setLanguage('ru'); assert.equal(t('langAuto'), 'Авто');
  setLanguage('en'); assert.equal(t('langAuto'), 'Auto');
 }
 delete globalThis.navigator;
 setLanguage('auto'); assert.equal(getCurrentLanguage(), 'en');
 const placeholders = s => [...s.matchAll(/\{(\w+)\}/g)].map(m => m[1]).sort();
 for (const [key, entry] of Object.entries(STRINGS)) {
  assert.ok(entry.en && entry.ru, `${key}: missing translation`);
  assert.deepEqual(placeholders(entry.en), placeholders(entry.ru), `${key}: mismatched placeholders`);
 }
 for (const file of await readdir(new URL('../src/', import.meta.url))) {
  if (!file.endsWith('.ts')) continue;
  const text = await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8');
  for (const match of text.matchAll(/\bt\("([^"]+)"/g)) assert.ok(STRINGS[match[1]], `${file}: unknown key ${match[1]}`);
 }
 console.log(`Language selection, manual overrides and ${Object.keys(STRINGS).length} EN/RU translations passed`);
} finally {
 if (original) Object.defineProperty(globalThis, 'navigator', original);
 else delete globalThis.navigator;
}
