// Copyright (c) Microsoft Corporation. All rights reserved. Licensed under the MIT license.
// See LICENSE in the project root for license information.

import * as fs from 'fs';
import * as nodeJsPath from 'path';
import {
  Encoding,
  Text,
  IFileSystemWriteFileOptions,
  IFileSystemReadFileOptions,
  IFileSystemCopyFileOptions,
  IFileSystemDeleteFileOptions,
  IFileSystemCreateLinkOptions,
  FileSystem,
  FileSystemStats
} from '@rushstack/node-core-library';

export interface IReadFolderFilesAndDirectoriesResult {
  files: string[];
  directories: string[];
}

export interface ICreateHardLinkExtendedOptions extends IFileSystemCreateLinkOptions {
  preserveExisting: boolean;
}

interface ICacheEntry<TEntry> {
  entry?: TEntry;
  error?: NodeJS.ErrnoException;
}

/**
 * This is a FileSystem API (largely unrelated to the @rushstack/node-core-library FileSystem API)
 * that provides caching to the Heft TypeScriptBuilder.
 * It uses an in-memory cache to avoid requests against the disk. It assumes that the disk stays
 * static after construction, except for writes performed through the TypeScriptCachedFileSystem
 * instance.
 */
export class TypeScriptCachedFileSystem {
  private _statsCache: Map<string, ICacheEntry<FileSystemStats>> = new Map<
    string,
    ICacheEntry<FileSystemStats>
  >();
  private _readFolderCache: Map<string, ICacheEntry<IReadFolderFilesAndDirectoriesResult>> = new Map<
    string,
    ICacheEntry<IReadFolderFilesAndDirectoriesResult>
  >();
  private _readFileCache: Map<string, ICacheEntry<Buffer>> = new Map<string, ICacheEntry<Buffer>>();
  private _realPathCache: Map<string, ICacheEntry<string>> = new Map<string, ICacheEntry<string>>();

  public exists: (path: string) => boolean = (path: string) => {
    try {
      this.getStatistics(path);
      return true;
    } catch (e) {
      if (FileSystem.isNotExistError(e)) {
        return false;
      } else {
        throw e;
      }
    }
  };

  public getStatistics: (path: string) => FileSystemStats = (path: string) => {
    return this._withCaching(path, FileSystem.getStatistics, this._statsCache);
  };

  public ensureFolder: (folderPath: string) => void = (folderPath: string) => {
    if (!this._readFolderCache.get(folderPath)?.entry && !this._statsCache.get(folderPath)?.entry) {
      FileSystem.ensureFolder(folderPath);
      this._invalidateCacheEntry(folderPath);
    }
  };

  public ensureFolderAsync: (folderPath: string) => Promise<void> = async (folderPath: string) => {
    if (!this._readFolderCache.get(folderPath)?.entry && !this._statsCache.get(folderPath)?.entry) {
      await FileSystem.ensureFolderAsync(folderPath);
      this._invalidateCacheEntry(folderPath);
    }
  };

  public writeFile: (
    filePath: string,
    contents: string | Buffer,
    options?: IFileSystemWriteFileOptions | undefined
  ) => void = (
    filePath: string,
    contents: string | Buffer,
    options?: IFileSystemWriteFileOptions | undefined
  ) => {
    FileSystem.writeFile(filePath, contents, options);
    this._invalidateCacheEntry(filePath);
  };

  public readFile: (filePath: string, options?: IFileSystemReadFileOptions | undefined) => string = (
    filePath: string,
    options?: IFileSystemReadFileOptions | undefined
  ) => {
    let contents: string = this.readFileToBuffer(filePath).toString(options?.encoding || Encoding.Utf8);
    if (options?.convertLineEndings) {
      contents = Text.convertTo(contents, options.convertLineEndings);
    }

    return contents;
  };

  public readFileToBuffer: (filePath: string) => Buffer = (filePath: string) => {
    return this._withCaching(filePath, FileSystem.readFileToBuffer, this._readFileCache);
  };

  public copyFileAsync: (options: IFileSystemCopyFileOptions) => Promise<void> = async (
    options: IFileSystemCopyFileOptions
  ) => {
    await FileSystem.copyFileAsync(options);
    this._invalidateCacheEntry(options.destinationPath);
  };

  public deleteFile: (filePath: string, options?: IFileSystemDeleteFileOptions | undefined) => void = (
    filePath: string,
    options?: IFileSystemDeleteFileOptions | undefined
  ) => {
    const cachedError: Error | undefined = this._statsCache.get(filePath)?.error;
    if (!cachedError || !FileSystem.isFileDoesNotExistError(cachedError)) {
      FileSystem.deleteFile(filePath);
      this._invalidateCacheEntry(filePath);
    } else if (options?.throwIfNotExists) {
      throw cachedError;
    }
  };

  public createHardLinkAsync: (options: IFileSystemCreateLinkOptions) => Promise<void> = async (
    options: IFileSystemCreateLinkOptions
  ) => {
    await FileSystem.createHardLinkAsync(options);
    this._invalidateCacheEntry(options.newLinkPath);
  };

  public getRealPath: (linkPath: string) => string = (linkPath: string) => {
    return this._withCaching(linkPath, FileSystem.getRealPath, this._realPathCache);
  };

  public readFolderFilesAndDirectories: (folderPath: string) => IReadFolderFilesAndDirectoriesResult = (
    folderPath: string
  ) => {
    return this._withCaching(
      folderPath,
      (path: string) => {
        // TODO: Replace this with a FileSystem API
        const folderEntries: fs.Dirent[] = fs.readdirSync(path, { withFileTypes: true });
        return this._sortFolderEntries(folderEntries);
      },
      this._readFolderCache
    );
  };

  public createHardLinkExtendedAsync: (options: ICreateHardLinkExtendedOptions) => Promise<boolean> = async (
    options: ICreateHardLinkExtendedOptions
  ) => {
    try {
      await this.createHardLinkAsync(options);
      return true;
    } catch (error) {
      if (error.code === 'EEXIST') {
        if (options.preserveExisting) {
          return false;
        }

        this.deleteFile(options.newLinkPath);
      } else if (FileSystem.isNotExistError(error)) {
        await this.ensureFolderAsync(nodeJsPath.dirname(options.newLinkPath));
      } else {
        throw error;
      }

      await this.createHardLinkAsync(options);
      return true;
    }
  };

  private _sortFolderEntries(folderEntries: fs.Dirent[]): IReadFolderFilesAndDirectoriesResult {
    // TypeScript expects entries sorted ordinally by name
    // In practice this might not matter
    folderEntries.sort((a, b) => {
      if (a > b) {
        return 1;
      } else if (a < b) {
        return -1;
      } else {
        return 0;
      }
    });

    const files: string[] = [];
    const directories: string[] = [];
    for (const folderEntry of folderEntries) {
      if (folderEntry.isFile()) {
        files.push(folderEntry.name);
      } else if (folderEntry.isDirectory()) {
        directories.push(folderEntry.name);
      }
    }

    return { files, directories };
  }

  private _withCaching<TResult>(
    path: string,
    fn: (path: string) => TResult,
    cache: Map<string, ICacheEntry<TResult>>
  ): TResult {
    let cacheEntry: ICacheEntry<TResult> | undefined = cache.get(path);
    if (!cacheEntry) {
      try {
        cacheEntry = { entry: fn(path) };
      } catch (e) {
        cacheEntry = { error: e };
      }

      cache.set(path, cacheEntry);
    }

    if (cacheEntry.entry) {
      return cacheEntry.entry;
    } else {
      throw cacheEntry.error;
    }
  }

  private _invalidateCacheEntry(path: string): void {
    this._statsCache.delete(path);
    this._readFolderCache.delete(path);
    this._readFileCache.delete(path);
    this._realPathCache.delete(path);
  }
}
