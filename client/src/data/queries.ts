// GraphQL documents used by the sync layer. The fake GitHub used in tests
// dispatches on the operation name, so keep the names stable.

/**
 * GitHub#349: the other end of a relation, as read with the item that names it (no request to its repository).
 */
const RELATED_ISSUE = 'number title url state stateReason repository { nameWithOwner }';
const relationList = (name: string, args: string, directive = '') =>
  `${name}(${args})${directive} { pageInfo { hasNextPage endCursor } nodes { ${RELATED_ISSUE} } }`;

/**
 * GitHub#349: one issue's relations — parent, sub-issues, blocked-by, blocking. The one piece
 * every read of an issue carries (the board read, the one-item re-read, the repository batch),
 * so they cannot ask for different things. A list longer than its first page is read on with
 * ISSUE_RELATIONS_QUERY.
 */
export const RELATION_FIELDS = `
    parent { ${RELATED_ISSUE} }
    ${relationList('subIssues', 'first: 50')}
    ${relationList('blockedBy', 'first: 20')}
    ${relationList('blocking', 'first: 20')}`;

const CONTENT_FIELDS = `
  __typename
  ... on Issue {
    id number title url state stateReason updatedAt
    repository { nameWithOwner }
    labels(first: 50) { nodes { name color } }
    assignees(first: 20) { nodes { login } }
    milestone { number title dueOn }
    author { login }
${RELATION_FIELDS}
    subIssuesSummary { total completed }
    closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
      nodes { number url state merged repository { nameWithOwner } }
    }
  }
  ... on PullRequest {
    id number title url state merged isDraft updatedAt body
    repository { nameWithOwner }
    labels(first: 50) { nodes { name color } }
    assignees(first: 20) { nodes { login } }
    milestone { number title dueOn }
    author { login }
  }
  ... on DraftIssue { title }
`;

export const PROJECT_ITEMS_QUERY = `
query CavilProjectItems($owner: String!, $number: Int!, $after: String, $isOrg: Boolean!) {
  organization(login: $owner) @include(if: $isOrg) { projectV2(number: $number) { ...P } }
  user(login: $owner) @skip(if: $isOrg) { projectV2(number: $number) { ...P } }
}
fragment P on ProjectV2 {
  id title url viewerCanUpdate
  fields(first: 50) {
    nodes {
      __typename
      ... on ProjectV2IterationField {
        id name
        configuration {
          iterations { id title startDate duration }
          completedIterations { id title startDate duration }
        }
      }
      ... on ProjectV2SingleSelectField { id name options { id name } }
    }
  }
  views(first: 30) {
    nodes {
      number name layout filter
      groupByFields(first: 5) { nodes { ... on ProjectV2FieldCommon { name dataType } } }
      verticalGroupByFields(first: 5) { nodes { ... on ProjectV2FieldCommon { name dataType } } }
      sortByFields(first: 5) { nodes { direction field { ... on ProjectV2FieldCommon { name dataType } } } }
      fields(first: 50) { nodes { ... on ProjectV2FieldCommon { name dataType } } }
    }
  }
  items(first: 100, after: $after) {
    totalCount
    pageInfo { hasNextPage endCursor }
    nodes {
      id isArchived
      fieldValues(first: 30) {
        nodes {
          __typename
          ... on ProjectV2ItemFieldIterationValue {
            iterationId title startDate duration
            field { ... on ProjectV2IterationField { id name } }
          }
          ... on ProjectV2ItemFieldSingleSelectValue {
            optionId name
            field { ... on ProjectV2SingleSelectField { id name } }
          }
        }
      }
      content { ${CONTENT_FIELDS} }
    }
  }
}
`;

/** fieldValues of one Project item, as the board reads them (shared by the board read and the one-item re-read) */
const ITEM_FIELD_VALUES = `
  fieldValues(first: 30) {
    nodes {
      __typename
      ... on ProjectV2ItemFieldIterationValue {
        iterationId title startDate duration
        field { ... on ProjectV2IterationField { id name } }
      }
      ... on ProjectV2ItemFieldSingleSelectValue {
        optionId name
        field { ... on ProjectV2SingleSelectField { id name } }
      }
    }
  }
`;

/** CONTENT_FIELDS without the DraftIssue part (it cannot be spread on IssueOrPullRequest) */
const ISSUE_OR_PR_FIELDS = CONTENT_FIELDS.replace('... on DraftIssue { title }', '');

/** Re-read one issue / PR after a change: the same fields the board shows, plus which Projects it is on. */
export const ITEM_REFRESH_QUERY = `
query CavilItemRefresh($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      ${ISSUE_OR_PR_FIELDS}
      ... on Issue { projectItems(first: 50) { nodes { id isArchived project { id } ${ITEM_FIELD_VALUES} } } }
      ... on PullRequest { projectItems(first: 50) { nodes { id isArchived project { id } ${ITEM_FIELD_VALUES} } } }
    }
  }
}
`;

/**
 * GitHub#349: the rest of one issue's relation lists, a page at a time; only the lists that
 * still have more are asked for (the @include switches).
 */
export const ISSUE_RELATIONS_QUERY = `
query CavilIssueRelations($id: ID!, $subIssues: Boolean!, $subIssuesAfter: String, $blockedBy: Boolean!, $blockedByAfter: String, $blocking: Boolean!, $blockingAfter: String) {
  node(id: $id) {
    __typename
    ... on Issue {
      ${relationList('subIssues', 'first: 100, after: $subIssuesAfter', ' @include(if: $subIssues)')}
      ${relationList('blockedBy', 'first: 100, after: $blockedByAfter', ' @include(if: $blockedBy)')}
      ${relationList('blocking', 'first: 100, after: $blockingAfter', ' @include(if: $blocking)')}
    }
  }
}
`;

/**
 * GitHub#349: the relations of up to 100 issues of a repository source, by node id, in one
 * request. (The REST issue list says only *how many* relations an issue has.)
 */
export const ISSUE_RELATIONS_BATCH_QUERY = `
query CavilIssueRelationsBatch($ids: [ID!]!) {
  nodes(ids: $ids) {
    __typename
    ... on Issue { id ${RELATION_FIELDS} }
  }
}
`;

/**
 * GitHub#258: which Projects a just-created issue (its node id) is on and its field values
 * there — to see whether a board took it in by itself. `totalCount`s tell a complete answer
 * from one cut short (cut short = unknown, never "not there" / "empty").
 */
export const CREATED_ITEM_BOARDS_QUERY = `
query CavilCreatedItemBoards($id: ID!) {
  node(id: $id) {
    ... on Issue {
      projectItems(first: 50) {
        totalCount
        nodes {
          id isArchived project { id }
          fieldValues(first: 100) {
            totalCount
            nodes {
              __typename
              ... on ProjectV2ItemFieldIterationValue {
                iterationId title startDate duration
                field { ... on ProjectV2IterationField { id name } }
              }
              ... on ProjectV2ItemFieldSingleSelectValue {
                optionId name
                field { ... on ProjectV2SingleSelectField { id name } }
              }
            }
          }
        }
      }
    }
  }
}
`;

/** GitHub#258: a Project's workflows (name + on / off), read on its own so a refusal never fails the board read. */
export const PROJECT_WORKFLOWS_QUERY = `
query CavilProjectWorkflows($id: ID!) {
  node(id: $id) { ... on ProjectV2 { workflows(first: 50) { totalCount nodes { name enabled } } } }
}
`;

/**
 * The issues a pull request closes (GitHub's "closing issues references"),
 * one page at a time: after a merge / close they are read again too
 * (GigleAI/cavil-loop#177). Read to the last page — the list has no upper bound.
 */
export const CLOSING_ISSUES_QUERY = `
query CavilClosingIssues($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { number repository { nameWithOwner } }
      }
    }
  }
}
`;

const LINE_COMMENT_FIELDS = 'id url createdAt bodyHTML path line originalLine author { login }';

/** The rest of one review's line comments (a review can hold more than one page of them). */
export const REVIEW_COMMENTS_QUERY = `
query CavilReviewComments($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReview {
      comments(first: 100, after: $after) { pageInfo { hasNextPage endCursor } nodes { ${LINE_COMMENT_FIELDS} } }
    }
  }
}
`;

const DETAIL_COMMENTS = `comments(first: 100, after: $commentsAfter) @include(if: $withComments) {
  pageInfo { hasNextPage endCursor }
  nodes { id url createdAt bodyHTML body viewerCanUpdate author { login } }
}`;

/**
 * The detail page: rendered body, every comment, every review with its line
 * comments, and for a PR what GitHub says about merging it. Comments and
 * reviews page independently (the @include switches let a follow-up page ask
 * for only the list that still has more).
 */
export const ITEM_DETAIL_QUERY = `
query CavilItemDetail($owner: String!, $name: String!, $number: Int!, $commentsAfter: String, $reviewsAfter: String, $withComments: Boolean!, $withReviews: Boolean!) {
  repository(owner: $owner, name: $name) {
    mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {
        id number title url state createdAt bodyHTML body viewerCanUpdate
        author { login }
        labels(first: 50) { nodes { name color } }
        ${DETAIL_COMMENTS}
      }
      ... on PullRequest {
        id number title url state merged isDraft createdAt bodyHTML body viewerCanUpdate
        author { login }
        labels(first: 50) { nodes { name color } }
        mergeable mergeStateStatus reviewDecision headRefOid baseRefName headRefName
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
        ${DETAIL_COMMENTS}
        reviews(first: 50, after: $reviewsAfter) @include(if: $withReviews) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id url state submittedAt createdAt bodyHTML author { login }
            comments(first: 100) { pageInfo { hasNextPage endCursor } nodes { ${LINE_COMMENT_FIELDS} } }
          }
        }
      }
    }
  }
}
`;

export const ADD_PROJECT_ITEM_MUTATION = `
mutation CavilAddProjectItem($projectId: ID!, $contentId: ID!) {
  addProjectV2ItemById(input: { projectId: $projectId, contentId: $contentId }) { item { id } }
}
`;

export const SET_ITERATION_MUTATION = `
mutation CavilSetIteration($projectId: ID!, $itemId: ID!, $fieldId: ID!, $iterationId: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { iterationId: $iterationId } }) { projectV2Item { id } }
}
`;

export const SET_STATUS_MUTATION = `
mutation CavilSetStatus($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId, value: { singleSelectOptionId: $optionId } }) { projectV2Item { id } }
}
`;

export const CLEAR_FIELD_MUTATION = `
mutation CavilClearField($projectId: ID!, $itemId: ID!, $fieldId: ID!) {
  clearProjectV2ItemFieldValue(input: { projectId: $projectId, itemId: $itemId, fieldId: $fieldId }) { projectV2Item { id } }
}
`;

export const VIEWER_QUERY = `query CavilViewer { viewer { login } }`;

/**
 * The markdown source of one body / comment, read again right before ticking a
 * box in it (GitHub#193): what it says now, whether this account may change it,
 * and which issue / PR it belongs to (a comment's `issue` is its PR for a PR comment).
 */
export const TASK_SOURCE_QUERY = `
query CavilTaskSource($id: ID!) {
  node(id: $id) {
    __typename
    ... on IssueComment { body viewerCanUpdate issue { number repository { nameWithOwner } } }
    ... on Issue { body viewerCanUpdate number repository { nameWithOwner } }
    ... on PullRequest { body viewerCanUpdate number repository { nameWithOwner } }
  }
}
`;

/**
 * The title of one issue / PR, read again right before changing it (GitHub#299): what it says
 * now and whether this account may change it. The same question for both kinds.
 */
export const TITLE_SOURCE_QUERY = `
query CavilTitleSource($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue { title viewerCanUpdate number }
      ... on PullRequest { title viewerCanUpdate number }
    }
  }
}
`;

/** Write a whole body back (GitHub has no "change one box"): one per kind of entry. */
export const UPDATE_COMMENT_MUTATION = `
mutation CavilUpdateComment($id: ID!, $body: String!) {
  updateIssueComment(input: { id: $id, body: $body }) { issueComment { body } }
}
`;
export const UPDATE_ISSUE_BODY_MUTATION = `
mutation CavilUpdateIssueBody($id: ID!, $body: String!) {
  updateIssue(input: { id: $id, body: $body }) { issue { body } }
}
`;
export const UPDATE_PR_BODY_MUTATION = `
mutation CavilUpdatePrBody($id: ID!, $body: String!) {
  updatePullRequest(input: { pullRequestId: $id, body: $body }) { pullRequest { body } }
}
`;

/**
 * GitHub#250 (code review round 1): the item's newest comments and label events. Read once before
 * an operation's first request goes out (what was there already) and again when proving a step
 * whose answer never came: only a record that was not there before counts.
 */
const OP_RECORDS_FIELDS = `
      comments(last: 100) { nodes { id body author { login } } }
      timelineItems(last: 100, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) {
        nodes { __typename ... on LabeledEvent { id actor { login } label { name } } ... on UnlabeledEvent { id actor { login } label { name } } }
      }`;
/**
 * GitHub#359: one read for a check of an operation / right before a send nobody clicked: the item's
 * state, its labels, its newest comments and one page of its label events (newest first page;
 * `$before` walks back). `labels.totalCount` and `pageInfo` say whether what came is everything.
 */
const OP_SNAPSHOT_FIELDS = `
      state
      labels(first: 100) { totalCount nodes { name } }
      comments(last: 100) { nodes { id body author { login } } }
      timelineItems(last: 100, before: $before, itemTypes: [LABELED_EVENT, UNLABELED_EVENT]) {
        pageInfo { hasPreviousPage startCursor }
        nodes { __typename ... on LabeledEvent { id actor { login } label { name } } ... on UnlabeledEvent { id actor { login } label { name } } }
      }`;
export const OP_SNAPSHOT_QUERY = `
query CavilOpSnapshot($owner: String!, $name: String!, $number: Int!, $before: String) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {${OP_SNAPSHOT_FIELDS}
      }
      ... on PullRequest {
        merged${OP_SNAPSHOT_FIELDS}
      }
    }
  }
}
`;
export const OP_RECORDS_QUERY = `
query CavilOpRecords($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    issueOrPullRequest(number: $number) {
      __typename
      ... on Issue {${OP_RECORDS_FIELDS}
      }
      ... on PullRequest {${OP_RECORDS_FIELDS}
      }
    }
  }
}
`;

/**
 * GitHub#261: the item count of every board, one query (one point). The change check needs it:
 * GitHub's "nothing changed" answer carries no next-page link, so an item added after a full
 * last page would otherwise go unseen. `p<i>` is the i-th board.
 */
export function projectCountsQuery(boards: { owner: string; number: number; isOrg: boolean }[]): { query: string; variables: Record<string, unknown> } {
  const params: string[] = [];
  const parts: string[] = [];
  const variables: Record<string, unknown> = {};
  boards.forEach((b, i) => {
    params.push(`$o${i}: String!`, `$n${i}: Int!`);
    variables[`o${i}`] = b.owner;
    variables[`n${i}`] = b.number;
    parts.push(`p${i}: ${b.isOrg ? 'organization' : 'user'}(login: $o${i}) { projectV2(number: $n${i}) { items(first: 0) { totalCount } } }`);
  });
  return { query: `query CavilProjectCounts(${params.join(', ')}) {\n  ${parts.join('\n  ')}\n}`, variables };
}
