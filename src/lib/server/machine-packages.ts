/**
 * The base toolset apk installs the first time a machine boots (see
 * ensureTmuxOnce in machine.ts). Kept in its own module rather than on
 * machine.ts because the prompts that describe the machine to a bot
 * (runner.ts, computer-agent.ts) name this same list, and machine.ts is
 * partially mocked in tests - a constant on it would be undefined under every
 * mock that did not think to stub it.
 */
export const MACHINE_PACKAGES = [
	'tmux',
	'bash',
	'curl',
	'wget',
	'git',
	'python3',
	'nodejs',
	'npm',
	'nmap',
	'netcat-openbsd',
	'bind-tools',
	'jq',
	'htop',
	'openssh-client'
];
