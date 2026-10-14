const {
  ConditionalCheckFailedException,
  DynamoDBClient,
  ScanCommand,
  UpdateItemCommand,
} = require('@aws-sdk/client-dynamodb');

const tableName = process.env.AUCTIONS_TABLE;
const applyChanges = process.argv.includes('--apply');
const sevenDaysInMilliseconds = 7 * 24 * 60 * 60 * 1000;

if (!tableName) {
  console.error('Set AUCTIONS_TABLE to the target DynamoDB table.');
  process.exitCode = 1;
} else {
  backfillAuctionEndDates().catch((error) => {
    console.error('Auction end-date migration failed:', error);
    process.exitCode = 1;
  });
}

async function backfillAuctionEndDates() {
  const dynamoDb = new DynamoDBClient({});
  let exclusiveStartKey;
  let scannedCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;

  do {
    const result = await dynamoDb.send(
      new ScanCommand({
        TableName: tableName,
        FilterExpression:
          '#entityType = :auction AND attribute_not_exists(#endDate)',
        ProjectionExpression: '#id, #createdAt',
        ExpressionAttributeNames: {
          '#id': 'id',
          '#createdAt': 'createdAt',
          '#entityType': 'entityType',
          '#endDate': 'endDate',
        },
        ExpressionAttributeValues: {
          ':auction': { S: 'AUCTION' },
        },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );

    for (const item of result.Items ?? []) {
      scannedCount += 1;
      const id = item.id?.S;
      const createdAt = item.createdAt?.S;
      const createdAtMilliseconds = createdAt ? Date.parse(createdAt) : NaN;

      if (!id || !Number.isFinite(createdAtMilliseconds)) {
        skippedCount += 1;
        console.warn('Skipping auction with missing id or invalid createdAt.');
        continue;
      }

      const endDate = new Date(
        createdAtMilliseconds + sevenDaysInMilliseconds,
      ).toISOString();

      if (!applyChanges) {
        console.log(`${id}: ${endDate}`);
        continue;
      }

      try {
        await dynamoDb.send(
          new UpdateItemCommand({
            TableName: tableName,
            Key: { id: { S: id } },
            UpdateExpression: 'SET #endDate = :endDate',
            ConditionExpression:
              'attribute_not_exists(#endDate) AND #entityType = :auction',
            ExpressionAttributeNames: {
              '#endDate': 'endDate',
              '#entityType': 'entityType',
            },
            ExpressionAttributeValues: {
              ':endDate': { S: endDate },
              ':auction': { S: 'AUCTION' },
            },
          }),
        );
        updatedCount += 1;
      } catch (error) {
        if (error instanceof ConditionalCheckFailedException) {
          skippedCount += 1;
          continue;
        }
        throw error;
      }
    }

    exclusiveStartKey = result.LastEvaluatedKey;
  } while (exclusiveStartKey);

  console.log(
    `${applyChanges ? 'Updated' : 'Found'} ${applyChanges ? updatedCount : scannedCount} auction(s); skipped ${skippedCount}.`,
  );
  if (!applyChanges) {
    console.log('Dry run only. Pass --apply to write endDate values.');
  }

  dynamoDb.destroy();
}