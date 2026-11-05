// GraphQL documents used by the sync layer. The fake GitHub used in tests
// dispatches on the operation name, so keep the names stable.

const CONTENT_FIELDS = `
  __typename
  ... on Issue {
    number title url state updatedAt
    repository { nameWithOwner }
    labels(first: 50) { nodes { name color } }
    assignees(first: 20) { nodes { login } }
    milestone { number title dueOn }
    author { login }
    parent { number repository { nameWithOwner } }
    subIssuesSummary { total completed }
    closedByPullRequestsReferences(first: 10, includeClosedPrs: true) {
      nodes { number url state merged repository { nameWithOwner } }
    }
  }
  ... on PullRequest {
    number title url state merged updatedAt
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
  id title url
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

export const VIEWER_QUERY = `query CavilViewer { viewer { login } }`;
