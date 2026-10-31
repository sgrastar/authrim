/** Sample rows for table stories (names are fictional). */
export interface DemoUser {
	id: string;
	name: string;
	email: string;
	role: string;
	lastLogin: string;
}

export const USERS: DemoUser[] = [
	{
		id: 'u1',
		name: 'Aiko Tanaka',
		email: 'aiko.tanaka@acme.test',
		role: 'admin',
		lastLogin: '2026-09-24 09:12'
	},
	{
		id: 'u2',
		name: 'Ben Müller',
		email: 'ben.mueller@acme.test',
		role: 'member',
		lastLogin: '2026-09-21 17:40'
	},
	{
		id: 'u3',
		name: 'Carla Souza',
		email: 'carla@acme.test',
		role: 'member',
		lastLogin: '2026-08-30 11:05'
	},
	{
		id: 'u4',
		name: 'Dmitri Volkov',
		email: 'd.volkov@acme.test',
		role: 'auditor',
		lastLogin: '2026-09-25 08:01'
	},
	{
		id: 'u5',
		name: 'Emi Sato',
		email: 'emi.sato@acme.test',
		role: 'member',
		lastLogin: '2026-07-14 13:22'
	}
];
