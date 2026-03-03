import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InstalledList } from './installed-list';
import { VeConfigurationService } from '../ve-configuration.service';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ensureAngularTesting } from '../../test-setup';
import type { IInstallationsResponse } from '../../shared/types';

// Hinweis: TestBed-Init erfolgt global in src/test-setup.ts

class MockVeConfigurationService {
  getInstallations = vi.fn(() => of<IInstallationsResponse>([
    {
      vm_id: 101,
      hostname: 'cont-01',
      oci_image: 'ghcr.io/acme/app-alpha:1.2.3',
      icon: '',
    },
    {
      vm_id: 104,
      hostname: 'cont-02',
      oci_image: 'ghcr.io/acme/app-beta:4.5.6',
      icon: '',
    },
  ]));
  postVeCopyUpgrade = vi.fn(() => of({ success: true, restartKey: 'rk_test' }));
  postVeUpgrade = vi.fn(() => of({ success: true, restartKey: 'rk_test' }));
}

// Sicherstellen, dass die Angular Test-Umgebung aktiv ist (ohne deprecated Importe im Spec)
ensureAngularTesting();

describe('InstalledList component (vitest)', () => {
  let svc: MockVeConfigurationService;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InstalledList],
      providers: [
        provideRouter([]),
        { provide: VeConfigurationService, useClass: MockVeConfigurationService },
      ],
    }).compileComponents();

    svc = TestBed.inject(VeConfigurationService) as unknown as MockVeConfigurationService;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate');
  });

  it('lädt zwei Installationen und rendert zwei Karten', async () => {
    const fixture = TestBed.createComponent(InstalledList);
    fixture.detectChanges();

    // Erwartung: getInstallations wurde aufgerufen und zwei Karten sind gerendert
    expect(svc.getInstallations).toHaveBeenCalledTimes(1);

    const el: HTMLElement = fixture.nativeElement as HTMLElement;
    // Suche Buttons - 2 Karten mit je 3 Buttons (Upgrade + Copy-Upgrade + Reconfigure) = 6
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.card-actions button'));
    expect(buttons.length).toBe(6);

    // Klick auf ersten Copy-Upgrade Button (Index 1, nach Upgrade-Button)
    buttons[1].click();
    fixture.detectChanges();
    expect(svc.postVeCopyUpgrade).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/monitor']);
  });
});
