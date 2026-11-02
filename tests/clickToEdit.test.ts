import { Text } from '@codemirror/state';
import { describe, expect, test } from 'bun:test';
import { docPosForTarget, findFenceLine, leadingBlankLines } from 'packages/obsidian/src/codemirror/Cm6_ClickToEdit';

describe('click to edit position mapping', () => {
	const note = ['# Title', '', '```js', '', 'const a = 1;', '  foo(a);   ', '```', 'after'];
	const doc = Text.of(note);
	const source = ['', 'const a = 1;', '  foo(a);   '].join('\n');

	test('leading blank lines are skipped like Expressive Code does', () => {
		expect(leadingBlankLines(source)).toBe(1);
		expect(leadingBlankLines('a\n\nb')).toBe(0);
		expect(leadingBlankLines('\n\n')).toBe(0);
	});

	test('maps rendered line/ch to the document', () => {
		// rendered line 0 = "const a = 1;" (doc line 5), ch 6 -> before "a"
		const pos = docPosForTarget(doc, 2, source, { line: 0, ch: 6 });
		expect(doc.sliceString(pos!, pos! + 1)).toBe('a');
	});

	test('clamps past end of line to trimmed line length', () => {
		const pos = docPosForTarget(doc, 2, source, { line: 1, ch: Number.MAX_SAFE_INTEGER });
		const line = doc.lineAt(pos!);
		expect(line.text).toBe('  foo(a);   ');
		expect(pos! - line.from).toBe('  foo(a);'.length);
	});

	test('header click goes to end of fence line', () => {
		const pos = docPosForTarget(doc, 2, source, { line: -1, ch: 0 });
		expect(pos).toBe(doc.line(3).to);
	});

	test('handles callout prefixes', () => {
		const d = Text.of(['> [!note]', '> ```py', '> x = 1', '> ```']);
		const pos = docPosForTarget(d, 1, 'x = 1', { line: 0, ch: 4 });
		expect(d.sliceString(pos!, pos! + 1)).toBe('1');
	});

	test('out of range returns null', () => {
		expect(docPosForTarget(doc, 100, source, { line: 0, ch: 0 })).toBeNull();
	});

	test('finds the fence of a block nested in a callout, skipping earlier blocks', () => {
		const d = Text.of(['```js', 'x = 1', '```', '', '> [!note]', '> text', '> ```py', '> x = 1', '> print(x)', '> ```']);
		expect(findFenceLine(d, 4, 'x = 1\nprint(x)')).toBe(6);
		expect(findFenceLine(d, 0, 'x = 1')).toBe(0);
		expect(findFenceLine(d, 4, 'nope')).toBeNull();
	});
});
