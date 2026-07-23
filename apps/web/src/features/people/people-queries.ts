import { queryOptions } from '@tanstack/react-query';

import { previewPeopleDataSource } from './people-data-source';
import { mergeHistory, people } from './people-preview';

export const peopleQueryKeys = {
  all: ['people'] as const,
  list: () => [...peopleQueryKeys.all, 'list'] as const,
  mergeHistory: () => [...peopleQueryKeys.all, 'merge-history'] as const,
};

export const peoplePreviewQuery = queryOptions({
  queryKey: peopleQueryKeys.list(),
  queryFn: () => previewPeopleDataSource.listPeople(),
  initialData: people,
});

export const mergeHistoryPreviewQuery = queryOptions({
  queryKey: peopleQueryKeys.mergeHistory(),
  queryFn: () => previewPeopleDataSource.listMergeHistory(),
  initialData: mergeHistory,
});
