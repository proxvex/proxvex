
import { ApplicationConfig, provideBrowserGlobalErrorListeners, provideZoneChangeDetection, APP_INITIALIZER, inject } from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';
import { HTTP_INTERCEPTORS, provideHttpClient, withInterceptorsFromDi } from '@angular/common/http';
import { routes } from './app.routes';
import { VeConfigurationService } from './ve-configuration.service';
import { AuthService } from './auth/auth.service';
import { AuthInterceptor } from './auth/auth.interceptor';
import { firstValueFrom } from 'rxjs';
import { catchError, of } from 'rxjs';

function initializeAuth(): () => Promise<void> {
  const auth = inject(AuthService);
  return () => auth.loadAuthConfig();
}

function initializeVeContext(): () => Promise<void> {
  const cfg = inject(VeConfigurationService);
  return () => firstValueFrom(cfg.initVeContext().pipe(catchError(() => of([])))).then(() => undefined);
}

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes),
    provideHttpClient(withInterceptorsFromDi()),
    { provide: HTTP_INTERCEPTORS, useClass: AuthInterceptor, multi: true },
    provideAnimations(),
    {
      provide: APP_INITIALIZER,
      useFactory: initializeAuth,
      multi: true,
    },
    {
      provide: APP_INITIALIZER,
      useFactory: initializeVeContext,
      multi: true,
    },
  ]
};
