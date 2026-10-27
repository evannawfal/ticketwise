---
title: Troubleshooting sync and offline issues
url: https://help.northpine.example/troubleshooting/sync
---
# Troubleshooting sync

## Changes not showing on another device

1. Check the sync indicator in the bottom-left corner. A grey cloud means the app is offline.
2. Make sure both devices are signed in to the same workspace.
3. Update the app. Versions older than 4.2 can't sync with the current server and show "Update required".
4. On desktop, sign out and back in to rebuild the local cache. Unsynced changes are kept.

## Offline mode

The desktop and mobile apps keep working offline. Changes are saved locally and upload automatically when the connection comes back. If two people edit the same task field while one is offline, the most recent edit wins and the other version is kept in the task's history.

## "Something went wrong" when opening a board

This usually means the local cache is corrupted. On desktop, go to Help > Troubleshooting > Clear local cache and restart the app. On mobile, sign out and sign back in. Clearing the cache does not delete any data stored on our servers.

## Attachments won't upload

Files up to 250 MB are supported on paid plans and up to 10 MB on Free. Uploads fail on some company networks that block our storage domain; ask IT to allow `files.northpine.example`.

## Check service status

See status.northpine.example for current incidents. You can subscribe there to email or SMS updates.
