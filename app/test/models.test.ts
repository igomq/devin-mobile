import test from 'node:test';
import assert from 'node:assert/strict';
import { isModeOption } from '../src/lib/models.ts';
import type { ConfigOption } from '../src/lib/types.ts';

const option = (overrides: Partial<ConfigOption>): ConfigOption => ({
	id: 'option',
	name: 'Option',
	type: 'select',
	currentValue: '',
	...overrides,
});

test('value-less mode-named toggles stay generic config options', () => {
	const fast = option({ id: 'fast', name: 'Fast mode', category: 'speed', type: 'boolean', currentValue: false });
	const approval = option({ id: 'approval', name: 'Approval', type: 'boolean', currentValue: false });
	assert.equal(isModeOption(fast), false);
	assert.equal(isModeOption(approval), false);
});

test('selectable permission modes are still recognized', () => {
	const mode = option({
		id: 'permissions',
		name: 'Permissions',
		category: 'mode',
		currentValue: 'ask',
		options: [
			{ value: 'ask', name: 'Ask' },
			{ value: 'auto', name: 'Auto' },
		],
	});
	assert.equal(isModeOption(mode), true);
});

test('select-valued fast, collaboration, and effort options are not mode options', () => {
	const values = [
		{ value: 'off', name: 'Off' },
		{ value: 'on', name: 'On' },
	];
	const fast = option({ id: 'fast-mode', name: 'Fast mode', category: 'speed', currentValue: 'off', options: values });
	const collaboration = option({
		id: 'collaboration_mode',
		name: 'Collaboration mode',
		category: 'collaboration_mode',
		currentValue: 'default',
		options: values,
	});
	const effort = option({ id: 'effort', name: 'Reasoning effort', category: 'thought_level', currentValue: 'medium', options: values });
	assert.equal(isModeOption(fast), false);
	assert.equal(isModeOption(collaboration), false);
	assert.equal(isModeOption(effort), false);
});
