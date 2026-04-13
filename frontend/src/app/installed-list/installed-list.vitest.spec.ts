import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { InstalledList } from './installed-list';
import { VeConfigurationService } from '../ve-configuration.service';
import { CacheService } from '../shared/services/cache.service';
import { Router, provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { ensureAngularTesting } from '../../test-setup';
import type { IInstallationsResponse } from '../../shared/types';

const mockInstallations: IInstallationsResponse = [
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
];

class MockVeConfigurationService {
  getVeContextKey = vi.fn(() => 've_testhost');
  getInstallations = vi.fn(() => of<IInstallationsResponse>(mockInstallations));
  getInstallationVersions = vi.fn(() => of({ services: [], framework: 'oci-image' }));
  postVeUpgrade = vi.fn(() => of({ success: true, restartKey: 'rk_test' }));
}

class MockCacheService {
  getInstallations = vi.fn(() => of(mockInstallations));
}

// Ensure Angular testing environment is active (without deprecated imports in spec)
ensureAngularTesting();

describe('InstalledList component (vitest)', () => {
  let svc: MockVeConfigurationService;
  let cacheService: MockCacheService;
  let router: Router;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [InstalledList],
      providers: [
        provideRouter([]),
        { provide: VeConfigurationService, useClass: MockVeConfigurationService },
        { provide: CacheService, useClass: MockCacheService },
      ],
    }).compileComponents();

    svc = TestBed.inject(VeConfigurationService) as unknown as MockVeConfigurationService;
    cacheService = TestBed.inject(CacheService) as unknown as MockCacheService;
    router = TestBed.inject(Router);
    vi.spyOn(router, 'navigate');
  });

  it('loads two installations and renders two cards', async () => {
    const fixture = TestBed.createComponent(InstalledList);
    fixture.detectChanges();

    // Expect: getInstallations was called on CacheService
    expect(cacheService.getInstallations).toHaveBeenCalledTimes(1);

    const el: HTMLElement = fixture.nativeElement as HTMLElement;
    // 2 installation cards should be rendered (each has action buttons)
    const buttons = Array.from(el.querySelectorAll<HTMLButtonElement>('.card-actions button'));
    expect(buttons.length).toBeGreaterThanOrEqual(2);
  });
});
