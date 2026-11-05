// GraphQL documents used by the sync layer. The fake GitHub used in tests
// dispatches on the operation name, so keep the names stable.

const CONTENT_FIELDS = `
  __typename
  ... on Issue {
    id number title url state updatedAt
    repository { nameWithOwner }
    labels(first: 50) { nodes { name color } }
    assignees(first: 20) { nodes { login } }
    milestone { number title dueOn }
  }
  ... on PullRequest {
    id number title url state merged updatedAt
    repository { nameWithOwner }
    labels(first: 50) { nodes { name color } }
    assignees(first: 20) { nodes { login } }
    milestone { number title dueOn }
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

const DETAIL_COMMENTS = `comments(first: 100, after: $commentsAfter) @include(if: $withComments) {
  pageInfo { hasNextPage endCursor }
  nodes { id url createdAt bodyHTML author { login } }
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
        id number title url state createdAt bodyHTML
        author { login }
        labels(first: 50) { nodes { name color } }
        ${DETAIL_COMMENTS}
      }
      ... on PullRequest {
        id number title url state merged isDraft createdAt bodyHTML
        author { login }
        labels(first: 50) { nodes { name color } }
        mergeable mergeStateStatus reviewDecision headRefOid baseRefName headRefName
        commits(last: 1) { nodes { commit { oid statusCheckRollup { state } } } }
        ${DETAIL_COMMENTS}
        reviews(first: 50, after: $reviewsAfter) @include(if: $withReviews) {
          pageInfo { hasNextPage endCursor }
          nodes {
            id url state submittedAt createdAt bodyHTML author { login }
            comments(first: 100) { totalCount nodes { id url createdAt bodyHTML path line originalLine author { login } } }
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
