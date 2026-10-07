import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { EN } from './i18n.en';
import { translate } from './i18n';

const SRC = path.resolve(__dirname, '..');
const walk = (d: string): string[] =>
  fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (['server', '__tests__'].includes(e.name) ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]
  );

function usedKeys(): Set<string> {
  const keys = new Set<string>();
  for (const file of walk(SRC).filter((f) => /\.tsx?$/.test(f) && !/i18n\.en\.ts$|\.test\./.test(f))) {
    const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const visit = (n: ts.Node) => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ['t', 'msg'].includes(n.expression.text) && n.arguments.length) {
        const a = n.arguments[0];
        if (ts.isStringLiteral(a) || ts.isNoSubstitutionTemplateLiteral(a)) keys.add(a.text);
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return keys;
}

describe('i18n', () => {
  it('todo t()/msg() do código tem tradução em inglês', () => {
    const missing = [...usedKeys()].filter((k) => !(k in EN));
    expect(missing).toEqual([]);
  });

  it('não há tradução órfã no dicionário', () => {
    const used = usedKeys();
    expect(Object.keys(EN).filter((k) => !used.has(k))).toEqual([]);
  });

  it('mantém as mesmas variáveis {x} nas duas línguas', () => {
    const vars = (s: string) => (s.match(/\{\w+\}/g) ?? []).sort().join(',');
    for (const [pt, en] of Object.entries(EN)) expect(vars(en), pt).toBe(vars(pt));
  });

  it('interpola variáveis e cai no português sem tradução', () => {
    expect(translate('en', 'Faltam cerca de {v1} min', { v1: 3 })).toBe('About 3 min left');
    expect(translate('pt', 'Faltam cerca de {v1} min', { v1: 3 })).toBe('Faltam cerca de 3 min');
    expect(translate('en', 'texto sem tradução')).toBe('texto sem tradução');
  });
});
