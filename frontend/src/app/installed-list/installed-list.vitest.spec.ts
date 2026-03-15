import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InstalledList } from './installed-list';
import { VeConfigurationService } from '../ve-configuration.service';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ensureAngularTesting } from '../../test-setup';
import type { IInstallationsResponse } from '../../shared/types';

// Note: TestBed init happens globally in src/test-setup.ts

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
  postVeUpgrade = vi.fn(() => of({ success: true, restartKey: 'rk_test' }));
}

// Ensure Angular testing environment is active (without deprecated imports in spec)
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

  it('loads two installations and renders two cards', async () => {
    const fixture = TestBed.createComponent(InstalledList);
    fixture.detectChanges();

    // Expect: getInstallations was called and two cards are rendered
    expect(svc.getInstallations).toHaveBeenCalledTimes(1);

    const el: HTMLElement = fixture.nativeElement as HTMLElement;
    // 2 cards with 2 buttons each (Upgrade + Reconfigure) = 4
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.card-actions button'));
    expect(buttons.length).toBe(4);

    // Click Upgrade button (index 0) of the first card
    buttons[0].click();
    fixture.detectChanges();
    expect(svc.postVeUpgrade).toHaveBeenCalledTimes(1);
    expect(router.navigate).toHaveBeenCalledWith(['/monitor']);
  });
});
