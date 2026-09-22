/**
 * 进程协议单元测试
 *
 * 测试 ProcessIdentity、StopObservation 类型及相关工具函数。
 */

import { describe, it, expect } from 'vitest';
import {
  generateJobName,
  generateAttemptId,
  isValidAttemptId,
  isValidJobName,
  extractIdentity,
  mergeIdentity,
  isCurrentAttempt,
  type ProcessIdentity,
} from '../../packages/process/src/process-protocol.js';

describe('process-protocol', () => {
  describe('generateJobName', () => {
    it('should generate valid job name with default prefix', () => {
      const name = generateJobName();
      expect(isValidJobName(name)).toBe(true);
      expect(name).toMatch(/^DevFlow\./);
    });

    it('should generate valid job name with custom prefix', () => {
      const name = generateJobName('Test');
      expect(isValidJobName(name)).toBe(true);
      expect(name).toMatch(/^Test\./);
    });

    it('should generate unique names', () => {
      const names = new Set(Array.from({ length: 100 }, () => generateJobName()));
      expect(names.size).toBe(100);
    });
  });

  describe('generateAttemptId', () => {
    it('should generate valid attempt id', () => {
      const id = generateAttemptId();
      expect(isValidAttemptId(id)).toBe(true);
    });

    it('should generate unique ids', () => {
      const ids = new Set(Array.from({ length: 100 }, () => generateAttemptId()));
      expect(ids.size).toBe(100);
    });
  });

  describe('isValidAttemptId', () => {
    it('should accept valid format', () => {
      expect(isValidAttemptId('att_1234567890_abcdefgh')).toBe(true);
    });

    it('should reject invalid formats', () => {
      expect(isValidAttemptId('')).toBe(false);
      expect(isValidAttemptId('invalid')).toBe(false);
      expect(isValidAttemptId('att_123')).toBe(false);
      expect(isValidAttemptId('att_123_short')).toBe(false);
    });
  });

  describe('isValidJobName', () => {
    it('should accept valid format', () => {
      expect(isValidJobName('DevFlow.abc123.xyz789')).toBe(true);
      expect(isValidJobName('Test.abc.defghi')).toBe(true);
    });

    it('should reject invalid formats', () => {
      expect(isValidJobName('')).toBe(false);
      expect(isValidJobName('invalid')).toBe(false);
      expect(isValidJobName('DevFlow.abc')).toBe(false);
    });
  });

  describe('extractIdentity', () => {
    it('should extract valid identity', () => {
      const identity: ProcessIdentity = {
        backend: 'node-v1',
        id: 'test-123',
        attempt_id: 'att_1234567890_abcdefgh',
        pid: 1234,
      };
      const record = { identity, other: 'data' };
      expect(extractIdentity(record)).toEqual(identity);
    });

    it('should return null for missing identity', () => {
      expect(extractIdentity({})).toBeNull();
      expect(extractIdentity({ identity: null })).toBeNull();
    });

    it('should return null for wrong backend', () => {
      const record = {
        identity: {
          backend: 'wrong',
          id: 'test',
          attempt_id: 'att_1234567890_abcdefgh',
        },
      };
      expect(extractIdentity(record)).toBeNull();
    });
  });

  describe('mergeIdentity', () => {
    it('should merge identity into record', () => {
      const record = { workflow_id: 'wf-1', status: 'running' };
      const identity: ProcessIdentity = {
        backend: 'node-v1',
        id: 'test-123',
        attempt_id: 'att_1234567890_abcdefgh',
        pid: 1234,
      };
      const merged = mergeIdentity(record, identity);
      expect(merged.workflow_id).toBe('wf-1');
      expect(merged.status).toBe('running');
      expect(merged.identity).toEqual(identity);
      expect(merged.updated_at).toBeDefined();
    });

    it('should overwrite existing identity', () => {
      const oldIdentity: ProcessIdentity = {
        backend: 'node-v1',
        id: 'old',
        attempt_id: 'att_old_oldoldold',
      };
      const newIdentity: ProcessIdentity = {
        backend: 'node-v1',
        id: 'new',
        attempt_id: 'att_new_newnewnew',
      };
      const record = { identity: oldIdentity };
      const merged = mergeIdentity(record, newIdentity);
      expect((merged.identity as ProcessIdentity).id).toBe('new');
    });
  });

  describe('isCurrentAttempt', () => {
    it('should match current attempt', () => {
      const identity: ProcessIdentity = {
        backend: 'node-v1',
        id: 'test',
        attempt_id: 'att_1234567890_abcdefgh',
      };
      const record = { identity };
      expect(isCurrentAttempt(record, 'att_1234567890_abcdefgh')).toBe(true);
    });

    it('should reject different attempt', () => {
      const identity: ProcessIdentity = {
        backend: 'node-v1',
        id: 'test',
        attempt_id: 'att_1234567890_abcdefgh',
      };
      const record = { identity };
      expect(isCurrentAttempt(record, 'att_9999999999_xyzxyzxy')).toBe(false);
    });

    it('should reject when no identity', () => {
      expect(isCurrentAttempt({}, 'att_1234567890_abcdefgh')).toBe(false);
    });
  });
});
