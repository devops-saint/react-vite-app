import { useFieldArray, Control, FieldErrors } from 'react-hook-form';
import {
  Box,
  Typography,
  Button,
  IconButton,
  TextField,
  Grid,
  Paper,
  Divider,
  Alert,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteIcon from '@mui/icons-material/Delete';
import ContentPasteIcon from '@mui/icons-material/ContentPaste';
import { CreateRequestSchema, detectDuplicates, parseS3BucketNames, parseArns } from '@/utils/validation';
import { useState } from 'react';

type ResourceType = 's3Buckets' | 'secretsManager' | 'kmsKeys' | 'lambdaFunctions';

interface ResourceSectionProps {
  resourceType: ResourceType;
  environmentIndex: number;
  control: Control<CreateRequestSchema>;
  errors: FieldErrors<CreateRequestSchema>;
}

const resourceTypeLabels: Record<ResourceType, string> = {
  s3Buckets: 'S3 Buckets',
  secretsManager: 'Secrets Manager',
  kmsKeys: 'KMS Keys',
  lambdaFunctions: 'Lambda Functions',
};

const resourceFieldNames: Record<ResourceType, string> = {
  s3Buckets: 'bucketName',
  secretsManager: 'secretArn',
  kmsKeys: 'keyArn',
  lambdaFunctions: 'functionArn',
};

const placeholders: Record<ResourceType, string> = {
  s3Buckets: 'my-bucket-name',
  secretsManager: 'arn:aws:secretsmanager:eu-west-1:123456789012:secret:my-secret',
  kmsKeys: 'arn:aws:kms:eu-west-1:123456789012:key/12345678-1234-1234-1234-123456789012',
  lambdaFunctions: 'arn:aws:lambda:eu-west-1:123456789012:function:my-function',
};

export function ResourceSection({ resourceType, environmentIndex, control, errors }: ResourceSectionProps) {
  const [pasteText, setPasteText] = useState('');
  const [showPaste, setShowPaste] = useState(false);
  const fieldName = resourceFieldNames[resourceType];

  const { fields, append, remove } = useFieldArray({
    control,
    name: `environments.${environmentIndex}.resources.${resourceType}`,
  });

  const handleAddResource = () => {
    append({ [fieldName]: '' } as never);
  };

  const handlePasteMultiple = () => {
    const values = resourceType === 's3Buckets' 
      ? parseS3BucketNames(pasteText)
      : parseArns(pasteText);

    if (values.length === 0) {
      alert('No valid values found in pasted text');
      return;
    }

    // Check for duplicates
    const existingValues = fields.map(f => f[fieldName as keyof typeof f] as string);
    const duplicates = detectDuplicates([...existingValues, ...values]);
    
    if (duplicates.length > 0) {
      alert(`Duplicate values detected: ${duplicates.join(', ')}`);
      return;
    }

    values.forEach(value => {
      append({ [fieldName]: value } as never);
    });

    setPasteText('');
    setShowPaste(false);
  };

  const getFieldError = (index: number) => {
    const envErrors = errors?.environments?.[environmentIndex];
    if (!envErrors) return undefined;
    
    const resourceErrors = envErrors.resources?.[resourceType];
    if (!resourceErrors || !Array.isArray(resourceErrors)) return undefined;
    
    // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
    const fieldError = resourceErrors[index];
    if (!fieldError) return undefined;
    
    // eslint-disable-next-line @typescript-eslint/no-unsafe-return, @typescript-eslint/no-unsafe-member-access
    return fieldError[fieldName as keyof typeof fieldError]?.message;
  };

  if (fields.length === 0 && !showPaste) {
    return (
      <Paper sx={{ p: 3, mb: 2 }}>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
          <Typography variant="h6">{resourceTypeLabels[resourceType]}</Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              size="small"
              startIcon={<ContentPasteIcon />}
              onClick={() => setShowPaste(true)}
            >
              Paste Multiple
            </Button>
            <Button
              variant="contained"
              size="small"
              startIcon={<AddIcon />}
              onClick={handleAddResource}
            >
              Add
            </Button>
          </Box>
        </Box>
        <Alert severity="info">
          No {resourceTypeLabels[resourceType].toLowerCase()} added yet. Click &quot;Add&quot; to get started.
        </Alert>
      </Paper>
    );
  }

  return (
    <Paper sx={{ p: 3, mb: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 2 }}>
        <Typography variant="h6">{resourceTypeLabels[resourceType]}</Typography>
        <Box sx={{ display: 'flex', gap: 1 }}>
          <Button
            size="small"
            startIcon={<ContentPasteIcon />}
            onClick={() => setShowPaste(!showPaste)}
          >
            Paste Multiple
          </Button>
          <Button
            variant="contained"
            size="small"
            startIcon={<AddIcon />}
            onClick={handleAddResource}
          >
            Add
          </Button>
        </Box>
      </Box>

      {showPaste && (
        <Box sx={{ mb: 3 }}>
          <TextField
            fullWidth
            multiline
            rows={4}
            label={`Paste ${resourceType === 's3Buckets' ? 'bucket names' : 'ARNs'} (one per line)`}
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder={`${placeholders[resourceType]}\n${placeholders[resourceType]}`}
          />
          <Box sx={{ display: 'flex', gap: 1, mt: 1 }}>
            <Button variant="contained" onClick={handlePasteMultiple}>
              Add All
            </Button>
            <Button onClick={() => { setPasteText(''); setShowPaste(false); }}>
              Cancel
            </Button>
          </Box>
        </Box>
      )}

      <Divider sx={{ mb: 2 }} />

      <Grid container spacing={2}>
        {fields.map((field, index) => {
          const fieldPath = `environments.${environmentIndex}.resources.${resourceType}.${index}.${fieldName}` as const;
          
          return (
            <Grid item xs={12} key={field.id}>
              <Box sx={{ display: 'flex', gap: 1, alignItems: 'flex-start' }}>
                <TextField
                  fullWidth
                  label={
                    resourceType === 's3Buckets' 
                      ? 'Bucket Name' 
                      : resourceType === 'lambdaFunctions'
                      ? 'Function ARN'
                      : 'ARN'
                  }
                  placeholder={placeholders[resourceType]}
                  {...control.register(fieldPath as never)}
                  error={!!getFieldError(index)}
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                  helperText={getFieldError(index)}
                />
                <IconButton
                  color="error"
                  onClick={() => remove(index)}
                  title="Delete"
                  sx={{ mt: 1 }}
                >
                  <DeleteIcon />
                </IconButton>
              </Box>
            </Grid>
          );
        })}
      </Grid>
    </Paper>
  );
}
