import {
  mergeHistory,
  people,
  type MergeHistoryPreview,
  type PersonPreview,
} from './people-preview';

export interface PeopleDataSource {
  listPeople(): Promise<PersonPreview[]>;
  listMergeHistory(): Promise<MergeHistoryPreview[]>;
}

/**
 * Temporary source until canonical identity management is available on shared
 * main. The route and view-model layer depend on this interface, not fixture
 * exports, so the eventual API adapter is a source swap only.
 */
export const previewPeopleDataSource: PeopleDataSource = {
  listPeople: async () => people,
  listMergeHistory: async () => mergeHistory,
};
