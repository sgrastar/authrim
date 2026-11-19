import type { jaOnboarding } from './ja';

export const enOnboarding: Record<keyof typeof jaOnboarding, string> = {
	'ob.title': 'First steps',
	'ob.lead':
		'A few things to try in a new environment. Start a guide to go to its page and be shown, step by step, where to work.',
	'ob.progress': '{done} of {total} done',
	'ob.progressLabel': 'First steps progress',
	'ob.allDone': 'All done. You can watch any guide again.',
	'ob.loadFailed': 'Could not load your progress.',
	'ob.saveFailed': 'Could not save your progress.',
	'ob.status.done': 'Done',
	'ob.status.todo': 'Not done',
	'ob.status.active': 'Guide running',
	'ob.start': 'Start guide',
	'ob.startNamed': 'Start guide: {name}',
	'ob.again': 'Watch again',
	'ob.againNamed': 'Watch again: {name}',
	'ob.stop': 'Stop guide',
	'ob.stopNamed': 'Stop guide: {name}',
	'ob.markDone': 'Mark as done',
	'ob.markDoneNamed': 'Mark as done: {name}',
	'ob.markTodo': 'Mark as not done',
	'ob.markTodoNamed': 'Mark as not done: {name}',
	'ob.next': 'Next',
	'ob.back': 'Back',
	'ob.close': 'Close guide',
	'ob.stepOf': '{current} of {total}',
	'ob.done.title': 'Done',
	'ob.done.body': '“{name}” is now checked.',
	'ob.done.back': 'Back to the list',

	'ob.signIn.title': 'Sign in first',
	'ob.signIn.desc': 'Open this tenant’s sign-in screen and sign in with a passkey.',
	'ob.signIn.s1.title': 'Tenant information is here',
	'ob.signIn.s1.body':
		'Everything about this tenant, its information and its settings, is under the “Tenant” category.',
	'ob.signIn.s2.title': 'Basics',
	'ob.signIn.s2.body':
		'From here you can check the sign-in address and the other information this tenant publishes.',
	'ob.signIn.s3.title': 'This tenant’s sign-in screen',
	'ob.signIn.s3.body':
		'The address people sign in at. Open it in a new tab, register an account and sign in with a passkey.',
	'ob.signIn.s3.action': 'Open the address in this row.',

	'ob.theme.title': 'Customize the sign-in screen',
	'ob.theme.desc':
		'Change the background picture and text colors of the sign-in screen with a theme.',
	'ob.theme.nav.title': 'Customizing the sign-in screen starts here',
	'ob.theme.nav.body':
		'Customizing the sign-in screen, and changing its background and logo, is under the “Customization” category.',
	'ob.theme.sub.title': 'Themes',
	'ob.theme.sub.body':
		'How the sign-in screen looks is saved as a theme. The themes you make are listed here.',
	'ob.theme.s1.title': 'Create a theme',
	'ob.theme.s1.body': 'To begin, create one theme.',
	'ob.theme.s1.action': 'Create a theme, or open one from the list.',
	'ob.theme.s2.title': 'Layout',
	'ob.theme.s2.body': 'Here you choose the layout of the screen.',
	'ob.theme.s3.title': 'Look',
	'ob.theme.s3.body': 'Here you change colors, such as the text color, and the typeface.',
	'ob.theme.s4.title': 'Images',
	'ob.theme.s4.body': 'Here you change the background picture and the logo.',
	'ob.theme.s4.action': 'Open this tab.',
	'ob.theme.s5.title': 'Choose a background',
	'ob.theme.s5.body': 'As a try, pick a background picture you like from the presets.',
	'ob.theme.s5.action': 'Open the presets with this button and choose a picture.',
	'ob.theme.s5.fallback': 'The background picture is set under the light tab. Open this tab.',
	'ob.theme.name.title': 'Name the theme',
	'ob.theme.name.body':
		'You chose a background. Before saving, give the theme a name you can tell apart in the list.',
	'ob.theme.name.action': 'Type a name, then press Next.',
	'ob.theme.name.fallback': 'This button lets you change the name. To keep it, just press Next.',
	'ob.theme.s6.title': 'Save',
	'ob.theme.s6.body':
		'Change anything else you like. What you change shows in the preview at once.',
	'ob.theme.s6.action': 'Press Save when you are done.',
	'ob.theme.apply.title': 'Apply it to the sign-in screen',
	'ob.theme.apply.body':
		'Saving alone does not change the sign-in screen. Applying makes this theme the look of this tenant’s sign-in screen.',
	'ob.theme.apply.action': 'Press Apply and confirm. The guide ends there.',

	'ob.schema.title': 'Add or change the schema',
	'ob.schema.desc': 'Add or change the attributes kept about each person.',
	'ob.schema.nav.title': 'What is kept about people is here',
	'ob.schema.nav.body':
		'The items kept about each person (attributes), and the permission settings, are under the “Access Control” category.',
	'ob.schema.sub.title': 'Attribute schema',
	'ob.schema.sub.body': 'The items kept for each person (attributes) are added and changed here.',
	'ob.schema.s1.title': 'Add an attribute',
	'ob.schema.s1.body':
		'An attribute is an item kept for each person. This button adds a new one. Open an attribute in the list to change it.',
	'ob.schema.preset.title': 'Choose from a preset',
	'ob.schema.preset.body':
		'Common items, such as a name or a phone number, can be chosen together from a preset.',

	'ob.screens.title': 'Customize the sign-up and sign-in screens',
	'ob.screens.desc': 'Put input parts on a screen and save what people enter to attributes.',
	'ob.screens.nav.title': 'What a screen asks for is decided here too',
	'ob.screens.nav.body':
		'The fields shown on the sign-up and sign-in screens are decided under the “Customization” category.',
	'ob.screens.sub.title': 'Screens',
	'ob.screens.sub.body': 'The parts of each screen, and their order, are saved as a screen.',
	'ob.screens.row.title': 'The sign-up screen',
	'ob.screens.row.body': 'The parts shown on the sign-up screen are decided by this screen.',
	'ob.screens.row.action': 'Open this row.',
	'ob.screens.row.fallback': 'The row is hidden by the search or the filter. Clear them here.',
	'ob.screens.s3.title': 'Input parts',
	'ob.screens.s3.body':
		'These parts save what a person enters to an attribute of the schema. Any attribute of the attribute schema can be chosen.',
	'ob.screens.s3.action': 'Press a part to add it to the screen.',
	'ob.screens.s4.title': 'Where the value is saved',
	'ob.screens.s4.body':
		'The settings of the part you added. Under where it is saved, choose any attribute you like to keep the entered value in.',
	'ob.screens.s5.title': 'Save',
	'ob.screens.s5.body': 'Arrange and set the parts however you like.',
	'ob.screens.s5.action': 'Press Save when you are done. The guide ends there.'
};
