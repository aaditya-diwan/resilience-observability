
import express, { Request, Response } from 'express';
import axios, { AxiosError } from 'axios';
import cors from 'cors';

const app = express();
const PORT = process.env.PORT || 3001;
const BACKEND_URL = process.env.BACKEND_URL || 'http://localhost:3000';

app.use(cors());
app.use(express.json());

enum CircuitState {
  CLOSED = 'CLOSED',
  OPEN = 'OPEN',
  HALF_OPEN = 'HALF_OPEN'
}

class CircuitBreaker {
  private state: CircuitState = CircuitState.CLOSED;
  private failureCount: number = 0;
  private successCount: number = 0;
  private lastFailureTime: number = 0;
  private nextAttemptTime: number = 0;

  constructor(
    private failureThreshold: number = 5,
    private resetTimeout: number = 60000, // 60 seconds
    private halfOpenMaxAttempts: number = 3
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    console.log(`Circuit Breaker State: ${this.state}`);
    if (this.state === CircuitState.OPEN) {
      if (Date.now() >= this.nextAttemptTime) {
        console.log('Circuit Breaker: Transitioning to HALF_OPEN');
        this.state = CircuitState.HALF_OPEN;
        this.successCount = 0;
      } else {
        throw new Error('Circuit breaker is OPEN - fast failing');
      }
    }

    try {
      const result = await operation();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess() {
    this.failureCount = 0;
    
    if (this.state === CircuitState.HALF_OPEN) {
      this.successCount++;
      console.log(`Circuit Breaker: Success in HALF_OPEN (${this.successCount}/${this.halfOpenMaxAttempts})`);
      
      if (this.successCount >= this.halfOpenMaxAttempts) {
        console.log('Circuit Breaker: Transitioning to CLOSED');
        this.state = CircuitState.CLOSED;
        this.successCount = 0;
      }
    }
  }

  private onFailure() {
    this.failureCount++;
    console.log(`Circuit Breaker: Failure detected. Current failures: ${this.failureCount}`); // Added log
    this.lastFailureTime = Date.now();
    
    if (this.state === CircuitState.HALF_OPEN) {
      console.log('Circuit Breaker: Failure in HALF_OPEN, reopening circuit');
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = Date.now() + this.resetTimeout;
      this.successCount = 0;
    } else if (this.failureCount >= this.failureThreshold) {
      console.log(`Circuit Breaker: Failure threshold reached (${this.failureCount}), opening circuit`);
      this.state = CircuitState.OPEN;
      this.nextAttemptTime = Date.now() + this.resetTimeout;
    }
  }

  getState() {
    return {
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      nextAttemptTime: this.state === CircuitState.OPEN ? 
        new Date(this.nextAttemptTime).toISOString() : null
    };
  }

  reset() {
    this.state = CircuitState.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.nextAttemptTime = 0;
  }
}

interface RetryConfig {
  maxRetries: number;
  initialDelay: number;
  maxDelay: number;
  backoffMultiplier: number;
  jitterFactor: number;
}

async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  config: RetryConfig = {
    maxRetries: 3,
    initialDelay: 1000,
    maxDelay: 10000,
    backoffMultiplier: 2,
    jitterFactor: 0.3
  }
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      console.log(`Retry attempt ${attempt + 1}/${config.maxRetries + 1}`);
      return await operation();
    } catch (error: any) {
      lastError = error;
      
      if (error.response?.status >= 400 && error.response?.status < 500) {
        throw error;
      }
      
      if (error.message?.includes('Circuit breaker is OPEN')) {
        throw error;
      }
      
      if (attempt < config.maxRetries) {
        const baseDelay = Math.min(
          config.initialDelay * Math.pow(config.backoffMultiplier, attempt),
          config.maxDelay
        );
        
        const jitter = baseDelay * config.jitterFactor * (Math.random() * 2 - 1);
        const delay = Math.max(0, baseDelay + jitter);
        
        console.log(`Retrying after ${delay.toFixed(0)}ms (attempt ${attempt + 1})`);
        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }
  
  throw lastError!;
}


const circuitBreaker = new CircuitBreaker(
  5, 
  60000, 
  3       
);

app.get('/health', (req: Request, res: Response) => {
  res.json({ 
    status: 'healthy',
    circuitBreaker: circuitBreaker.getState(),
    timestamp: new Date().toISOString()
  });
});

app.get('/circuit-breaker/status', (req: Request, res: Response) => {
  res.json(circuitBreaker.getState());
});

app.post('/circuit-breaker/reset', (req: Request, res: Response) => {
  circuitBreaker.reset();
  res.json({ message: 'Circuit breaker reset', state: circuitBreaker.getState() });
});

app.post('/api/users/register', async (req: Request, res: Response) => {
  console.log('Request Body in Client:', JSON.stringify(req.body));
  const { username, email, password } = req.body;
  
  try {
    const result = await circuitBreaker.execute(async () => {
      return await retryWithBackoff(async () => {
        console.log('Attempting axios.post to backend...');
        const response = await axios.post(
          `${BACKEND_URL}/api/register`,
          { username, email, password },
          {
            timeout: 5000
          }
        );
        console.log('Axios.post successful.');
        return response.data;
      });
    });
    
    res.status(201).json(result);
  } catch (error: any) {
    console.error('Registration error in client:', error.message); // Modified log
    if (error.code === 'ECONNABORTED') { // Added specific timeout error check
      console.error('Axios request timed out!');
    }
    
    if (error.message?.includes('Circuit breaker is OPEN')) {
      return res.status(503).json({ 
        error: 'Service temporarily unavailable - circuit breaker is open',
        circuitState: circuitBreaker.getState()
      });
    }
    
    if (error.response) {
      return res.status(error.response.status).json(error.response.data);
    }
    
    res.status(500).json({ error: 'Failed to register user', details: error.message });
  }
});

app.get('/api/users', async (req: Request, res: Response) => {
  try {
    const result = await circuitBreaker.execute(async () => {
      return await retryWithBackoff(async () => {
        const response = await axios.get(`${BACKEND_URL}/api/users`, { timeout: 5000 });
        return response.data;
      });
    });

    res.json(result);
  } catch (error: any) {
    console.error('Get users error:', error.message);
    if (error.response) {
      console.error('Response status:', error.response.status);
      console.error('Response data:', error.response.data);
    }

    if (error.message?.includes('Circuit breaker is OPEN')) {
      return res.status(503).json({
        error: 'Service temporarily unavailable',
        circuitState: circuitBreaker.getState()
      });
    }

    res.status(500).json({ error: 'Failed to fetch users', details: error.message });
  }
});

app.post('/chaos/delay', async (req: Request, res: Response) => {
  try {
    const response = await axios.post(`${BACKEND_URL}/chaos/delay`, req.body);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to configure chaos delay' });
  }
});

app.post('/chaos/error', async (req: Request, res: Response) => {
  try {
    const response = await axios.post(`${BACKEND_URL}/chaos/error`, req.body);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to configure chaos error' });
  }
});

app.listen(PORT, () => {
  console.log(`Client service (with resilience) running on port ${PORT}`);
  console.log(`Proxying to backend: ${BACKEND_URL}`);
});