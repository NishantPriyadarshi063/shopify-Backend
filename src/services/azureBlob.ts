import {
  BlobSASPermissions,
  StorageSharedKeyCredential,
  generateBlobSASQueryParameters,
  BlobSASSignatureValues,
} from '@azure/storage-blob';
import { config } from '../config';

const { storageAccountName, storageAccountKey, containerName, sasTtlMinutes } = config.azure;

const credential = new StorageSharedKeyCredential(storageAccountName, storageAccountKey);

/**
 * Base URL for a blob (no SAS). Store this in DB.
 * Format: https://<account>.blob.core.windows.net/<container>/<blobPath>
 */
export function getBlobUrl(blobPath: string): string {
  const base = `https://${storageAccountName}.blob.core.windows.net/${containerName}`;
  const path = blobPath.startsWith('/') ? blobPath.slice(1) : blobPath;
  return `${base}/${path}`;
}

/**
 * Generate a SAS URL for uploading (create/write) to a blob.
 * Client can PUT to this URL to upload. TTL from AZURE_SAS_TTL_MINUTES.
 */
export function getUploadSasUrl(blobPath: string): string {
  const expiresOn = new Date(Date.now() + sasTtlMinutes * 60 * 1000);
  const sasOptions: BlobSASSignatureValues = {
    containerName,
    blobName: blobPath,
    permissions: BlobSASPermissions.parse('cw'), // create, write
    startsOn: new Date(),
    expiresOn,
  };
  const sasToken = generateBlobSASQueryParameters(sasOptions, credential).toString();
  const url = getBlobUrl(blobPath);
  return `${url}?${sasToken}`;
}

/**
 * Generate a SAS URL for reading a blob (e.g. to display image/video in admin).
 * TTL from AZURE_SAS_TTL_MINUTES.
 */
export function getReadSasUrl(blobPath: string): string {
  const expiresOn = new Date(Date.now() + sasTtlMinutes * 60 * 1000);
  const sasOptions: BlobSASSignatureValues = {
    containerName,
    blobName: blobPath,
    permissions: BlobSASPermissions.parse('r'),
    startsOn: new Date(),
    expiresOn,
  };
  const sasToken = generateBlobSASQueryParameters(sasOptions, credential).toString();
  const url = getBlobUrl(blobPath);
  return `${url}?${sasToken}`;
}

/**
 * Generate a unique blob path for a new upload (help request or chat).
 * Example: help-requests/<requestId>/<uuid>.<ext>
 */
export function buildBlobPath(prefix: string, requestId: string, fileName: string): string {
  const sanitized = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const unique = `${Date.now()}-${sanitized}`;
  return `${prefix}/${requestId}/${unique}`;
}
