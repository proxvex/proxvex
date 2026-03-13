import { inject } from '@angular/core';
import { CanActivateFn } from '@angular/router';
import { AuthService } from './auth.service';

export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);

  if (!auth.isOidcEnabled) {
    return true;
  }

  if (auth.isAuthenticated) {
    return true;
  }

  // Redirect to OIDC login
  auth.login();
  return false;
};
