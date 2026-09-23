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

// 新协议使用 UUID 格式 attempt_id
const VALID_ATT_1 = '80766c70-8e32-4e3c-9cf9-3203cf6ea5f4';
const VALID_ATT_2 = '06db9c33-9411-4771-acd6-1f573af22b48';
const VALID_ATT_3 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('process-protocol', () => {
  describe('generateJobName', () => {
    it('should generate valid job name with default prefix', () => {
      const name = generateJobName();
      expect(isValidJobName(name)).toBe(true);
      expect(name).toMatch(/^Local\\DevFlow\./);
    });

    it('should generate valid job name with custom prefix', () => {
      const name = generateJobName('Test');
      expect(isValidJobName(name)).toBe(true);
      expect(name).toMatch(/^Local\\Test\./);
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
    it('should accept valid UUID format', () => {
      expect(isValidAttemptId(VALID_ATT_1)).toBe(true);
      expect(isValidAttemptId(VALID_ATT_2)).toBe(true);
    });

    it('should reject invalid formats', () => {
      expect(isValidAttemptId('')).toBe(false);
      expect(isValidAttemptId('invalid')).toBe(false);
      expect(isValidAttemptId('att_123')).toBe(false);
      expect(isValidAttemptId('att_1234567890_abcdefgh')).toBe(false);
    });
  });

  describe('isValidJobName', () => {
    it('should accept valid format', () => {
      expect(isValidJobName(`Local\\DevFlow.${VALID_ATT_1}`)).toBe(true);
      expect(isValidJobName(`Local\\Test.${VALID_ATT_2}`)).toBe(true);
    });

    it('should reject invalid formats', () => {
      expect(isValidJobName('')).toBe(false);
      expect(isValidJobName('invalid')).toBe(false);
      expect(isValidJobName(`DevFlow.${VALID_ATT_1}`)).toBe(false);
      expect(isValidJobName('Local\\DevFlow.abc')).toBe(false);
    });
  });

  describe('extractIdentity', () => {
    it('should extract valid identity', () => {
      const identity: ProcessIdentity = {
        backend: 'node-v1',
        id: 'test-123',
        attempt_id: VALID_ATT_1,
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
          attempt_id: VALID_ATT_1,
        },
      };
      expect(extractIdentity(record)).toBeNull();
    });

    it('should return null for invalid attempt_id', () => {
      const record = {
        identity: {
          backend: 'node-v1',
          id: 'test',
          attempt_id: 'att_invalid',
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
        attempt_id: VALID_ATT_1,
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
        attempt_id: VALID_ATT_1,
      };
      const newIdentity: ProcessIdentity = {
        backend: 'node-v1',
        id: 'new',
        attempt_id: VALID_ATT_2,
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
        attempt_id: VALID_ATT_1,
      };
      const record = { identity };
      expect(isCurrentAttempt(record, VALID_ATT_1)).toBe(true);
    });

    it('should reject different attempt', () => {
      const identity: ProcessIdentity = {
        backend: 'node-v1',
        id: 'test',
        attempt_id: VALID_ATT_1,
      };
      const record = { identity };
      expect(isCurrentAttempt(record, VALID_ATT_2)).toBe(false);
    });

    it('should reject when no identity', () => {
      expect(isCurrentAttempt({}, VALID_ATT_1)).toBe(false);
    });
  });
});
