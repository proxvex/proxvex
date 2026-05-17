import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TextTableControlComponent } from './text-table-control.component';
import { ensureAngularTesting } from '../../../../test-setup';

ensureAngularTesting();

describe('TextTableControlComponent', () => {
  let component: TextTableControlComponent;
  let fixture: ComponentFixture<TextTableControlComponent>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [TextTableControlComponent],
    }).compileComponents();

    fixture = TestBed.createComponent(TextTableControlComponent);
    component = fixture.componentInstance;
  });

  describe('writeValue', () => {
    it('splits a newline-separated string into rows', () => {
      component.writeValue('a\nb\nc');
      expect(component.rows).toEqual(['a', 'b', 'c']);
    });

    it('treats empty string as no rows', () => {
      component.writeValue('');
      expect(component.rows).toEqual([]);
    });

    it('treats null as no rows', () => {
      component.writeValue(null);
      expect(component.rows).toEqual([]);
    });

    it('preserves blank middle/trailing lines', () => {
      component.writeValue('a\n\nb\n');
      expect(component.rows).toEqual(['a', '', 'b', '']);
    });
  });

  describe('round-trip identity', () => {
    it('emits the original string unchanged when a row is re-set to its value', () => {
      const spy = vi.fn();
      component.registerOnChange(spy);
      component.writeValue('a\n\nb\n');
      component.updateRow(0, 'a');
      expect(spy).toHaveBeenLastCalledWith('a\n\nb\n');
    });

    it('CRLF input round-trips to LF-joined output', () => {
      const spy = vi.fn();
      component.registerOnChange(spy);
      component.writeValue('x\r\ny');
      expect(component.rows).toEqual(['x', 'y']);
      component.updateRow(1, 'y');
      expect(spy).toHaveBeenLastCalledWith('x\ny');
    });
  });

  describe('addRow', () => {
    it('appends and emits the newline-joined value', () => {
      const spy = vi.fn();
      component.registerOnChange(spy);
      component.writeValue('a');
      component.newRow = 'b';
      component.addRow();
      expect(component.rows).toEqual(['a', 'b']);
      expect(spy).toHaveBeenLastCalledWith('a\nb');
      expect(component.newRow).toBe('');
    });

    it('is a no-op for an empty new row', () => {
      const spy = vi.fn();
      component.registerOnChange(spy);
      component.writeValue('a');
      component.newRow = '';
      component.addRow();
      expect(component.rows).toEqual(['a']);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('deleteRow', () => {
    it('removes the row and emits the newline-joined value', () => {
      const spy = vi.fn();
      component.registerOnChange(spy);
      component.writeValue('a\nb\nc');
      component.deleteRow(1);
      expect(component.rows).toEqual(['a', 'c']);
      expect(spy).toHaveBeenLastCalledWith('a\nc');
    });
  });
});
