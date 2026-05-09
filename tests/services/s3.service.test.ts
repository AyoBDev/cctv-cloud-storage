import {
  uploadFaceImage,
  uploadEventThumbnail,
  getSignedUrl,
  deleteObject,
} from '../../src/services/s3.service';

describe('S3 Service', () => {
  describe('uploadFaceImage', () => {
    it('returns the S3 key in test env', async () => {
      const buffer = Buffer.from('fake-image');
      const key = await uploadFaceImage('org-1', 'profile-1', buffer, 'image/jpeg');
      expect(key).toBe('orgs/org-1/face-profiles/profile-1/original.jpg');
    });

    it('returns png extension for image/png', async () => {
      const buffer = Buffer.from('fake-image');
      const key = await uploadFaceImage('org-1', 'profile-1', buffer, 'image/png');
      expect(key).toBe('orgs/org-1/face-profiles/profile-1/original.png');
    });
  });

  describe('uploadEventThumbnail', () => {
    it('returns the S3 key in test env', async () => {
      const buffer = Buffer.from('fake-thumb');
      const key = await uploadEventThumbnail('org-1', 'event-1', buffer);
      expect(key).toBe('recognition-events/org-1/event-1/thumb.jpg');
    });
  });

  describe('getSignedUrl', () => {
    it('returns a mock signed URL in test env', async () => {
      const url = await getSignedUrl('some/key.jpg', 3600);
      expect(url).toContain('some/key.jpg');
      expect(url).toMatch(/^https:\/\/mock-s3/);
    });
  });

  describe('deleteObject', () => {
    it('resolves without error in test env', async () => {
      await expect(deleteObject('some/key.jpg')).resolves.toBeUndefined();
    });
  });
});
