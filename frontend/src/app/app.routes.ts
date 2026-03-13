
import { Routes } from '@angular/router';
import { Home } from './home/home';
import { ApplicationsList } from './applications-list/applications-list';
import { ProcessMonitor } from './process-monitor/process-monitor';
import { SshConfigPage } from './ssh-config-page/ssh-config-page';
import { CreateApplication } from './create-application/create-application';
import { InstalledList } from './installed-list/installed-list';
import { StacksPage } from './stacks-page/stacks-page';
import { authGuard } from './auth/auth.guard';

export const routes: Routes = [
	{ path: '', component: ApplicationsList, canActivate: [authGuard] },
	{ path: 'applications', component: ApplicationsList, canActivate: [authGuard] },
	{ path: 'home', component: Home, canActivate: [authGuard] },
	{ path: 'monitor', component: ProcessMonitor, canActivate: [authGuard] },
  { path: 'ssh-config', component: SshConfigPage, canActivate: [authGuard] },
  { path: 'create-application', component: CreateApplication, canActivate: [authGuard] },
	{ path: 'installations', component: InstalledList, canActivate: [authGuard] },
  { path: 'stacks', component: StacksPage, canActivate: [authGuard] },
];
