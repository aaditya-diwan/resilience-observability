```sh
minikube start
minikube docker-env | Invoke-Expression

docker build -t user-registration-backend:latest ./backend-service
docker build -t user-registration-client:latest ./client-service

minikube kubectl -- apply -f k8s/namespace.yaml

minikube kubectl -- apply -f k8s/

minikube service client-service --url -n user-registration # In new terminal
```

After this, we can test the endpoints using postman collection provided in this repository 