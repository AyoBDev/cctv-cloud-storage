import {
  createCollection,
  deleteCollection,
  indexFace,
  deleteFace,
  searchByImage,
  indexUnknownFace,
  searchUnknownByImage,
} from '../../src/services/rekognition.service';

describe('Rekognition Service', () => {
  describe('createCollection', () => {
    it('returns the collection id in test env', async () => {
      const result = await createCollection('org-123');
      expect(result).toBe('collection-org-123');
    });
  });

  describe('deleteCollection', () => {
    it('resolves without error in test env', async () => {
      await expect(deleteCollection('org-123')).resolves.toBeUndefined();
    });
  });

  describe('indexFace', () => {
    it('returns a mock face id in test env', async () => {
      const imageBytes = Buffer.from('fake-image');
      const result = await indexFace('org-123', imageBytes);
      expect(result).toMatch(/^mock-face-id-/);
    });
  });

  describe('deleteFace', () => {
    it('resolves without error in test env', async () => {
      await expect(deleteFace('org-123', 'face-id-1')).resolves.toBeUndefined();
    });
  });

  describe('searchByImage', () => {
    it('returns no matches for mock image in test env', async () => {
      const imageBytes = Buffer.from('fake-image');
      const result = await searchByImage('org-123', imageBytes, 80);
      expect(result).toEqual([]);
    });
  });

  describe('indexUnknownFace', () => {
    it('returns a mock unknown face id in test env', async () => {
      const imageBytes = Buffer.from('fake-image');
      const result = await indexUnknownFace('org-123', imageBytes);
      expect(result).toMatch(/^mock-unknown-face-id-/);
    });
  });

  describe('searchUnknownByImage', () => {
    it('returns null (no match) in test env', async () => {
      const imageBytes = Buffer.from('fake-image');
      const result = await searchUnknownByImage('org-123', imageBytes);
      expect(result).toBeNull();
    });
  });
});
