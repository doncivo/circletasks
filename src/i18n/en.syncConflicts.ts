import type { syncConflictsFr } from './fr.syncConflicts';

type Shape<T> = { readonly [K in keyof T]: T[K] extends string ? string : Shape<T[K]> };

/** `sync.conflicts` texts (Y-04), English. Same shape as `fr.syncConflicts.ts`. */
export const syncConflictsEn: Shape<typeof syncConflictsFr> = {
  listLabel: 'Conflict log',
  itemLabel: 'Conflict: {title}, {field}',
  heading: '{title} · {field}',
  deletedItem: 'Deleted item',
  kept: '{value} kept',
  discarded: '{value} discarded',
  side: '{device} · {time}',
  otherDevice: 'Other device',
  restore: 'Restore',
  restoreLabel: 'Restore the discarded value: {title}, {field}',
  restoring: 'Restoring…',
  restoredOn: 'Restored on {date}',
  showMore: 'Show more',
  quoted: '“{text}”',
  unreadableOne: '1 conflict in the log is unreadable and is not shown',
  unreadableMany: '{count} conflicts in the log are unreadable and are not shown',
  loadFailed: 'The conflict log could not be read. Reopen this screen to try again.',
  undoLabel: 'Value restored',
  result: {
    restored: 'Value restored: {title}, {field}',
    already: 'This value is already in place: conflict marked as resolved',
    rowGone: 'This item no longer exists: the value cannot be restored',
    parentGone: 'The linked item no longer exists: the value cannot be restored',
    invalid: 'Invalid value: it cannot be restored',
    failed: 'Restoring failed. Nothing was changed: try again.',
  },
  values: {
    empty: '(empty)',
    yes: 'Yes',
    no: 'No',
    deleted: 'deleted',
    modified: 'modified',
    present: 'present',
    todo: 'to do',
    done: 'done',
    noProject: 'No project',
  },
  kinds: {
    recurrence: 'Repeat',
    settings: 'Setting',
    other: 'Item',
  },
};
